#!/usr/bin/env python3
"""Jarvis job worker — executes executor:"host" jobs from the shared queue.

Scans JOBS_DIR (/data/jobs) for job files with executor == "host" and
status == 0, runs HOST_SCRIPTS/<name> inside this container (which has
the host filesystem bind-mounted), and writes status/output/rc back
into the same JSON file. The bridge container's /jobs endpoints serve
the results unchanged.

Env: JOBS_DIR, HOST_SCRIPTS_DIR, POLL_INTERVAL, HOST_TIMEOUT,
     HEALTH_FILE, MAX_OUTPUT
"""
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

STOP = False


def _stop(signum, frame):
    global STOP
    STOP = True
    print(f"worker: stop requested (signal={signum})", file=sys.stderr,
          flush=True)

JOBS = Path(os.getenv("JOBS_DIR", "/data/jobs"))
HOST_SCRIPTS = Path(os.getenv("HOST_SCRIPTS_DIR", "/app/host-scripts"))
POLL = float(os.getenv("POLL_INTERVAL", "2"))
HOST_TIMEOUT = int(os.getenv("HOST_TIMEOUT", "3600"))
MAX_OUTPUT = int(os.getenv("MAX_OUTPUT", "8000"))
HEALTH_FILE = Path(os.getenv("HEALTH_FILE", "/tmp/worker-health"))
NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

# Script signing configuration
SIGNER_PUBLIC_KEY = HOST_SCRIPTS / "jarvis-signer.pub"
SIGNATURES_FILE = HOST_SCRIPTS / ".signatures"


def verify_script_signature(script_path):
    """Verify GPG signature of a script. Returns True if valid."""
    if not SIGNER_PUBLIC_KEY.exists():
        print(f"worker: WARNING: No public key found at {SIGNER_PUBLIC_KEY}, skipping signature verification", file=sys.stderr, flush=True)
        return True  # Allow in development, but log warning
    
    signature_path = Path(str(script_path) + ".asc")
    if not signature_path.exists():
        print(f"worker: ERROR: No signature found for {script_path}", file=sys.stderr, flush=True)
        return False
    
    # Verify signature using gpg
    try:
        result = subprocess.run(
            ["gpg", "--verify", str(signature_path), str(script_path)],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print(f"worker: Script {script_path} signature verified", file=sys.stderr, flush=True)
            return True
        else:
            print(f"worker: ERROR: Signature verification failed for {script_path}: {result.stderr}", file=sys.stderr, flush=True)
            return False
    except Exception as e:
        print(f"worker: ERROR: Signature verification error for {script_path}: {e}", file=sys.stderr, flush=True)
        return False


def verify_script_checksum(script_path):
    """Verify script checksum against manifest. Returns True if valid."""
    if not SIGNATURES_FILE.exists():
        print(f"worker: WARNING: No signature manifest found, skipping checksum verification", file=sys.stderr, flush=True)
        return True
    
    try:
        with open(SIGNATURES_FILE, 'r') as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    timestamp, checksum, filename = parts[0], parts[1], parts[2]
                    if filename == script_path.name:
                        # Calculate current checksum
                        current_checksum = hashlib.sha256(script_path.read_bytes()).hexdigest()
                        if current_checksum == checksum:
                            print(f"worker: Script {script_path} checksum verified", file=sys.stderr, flush=True)
                            return True
                        else:
                            print(f"worker: ERROR: Checksum mismatch for {script_path}", file=sys.stderr, flush=True)
                            return False
        print(f"worker: ERROR: No checksum found for {script_path.name} in manifest", file=sys.stderr, flush=True)
        return False
    except Exception as e:
        print(f"worker: ERROR: Checksum verification error for {script_path}: {e}", file=sys.stderr, flush=True)
        return False


def write_job(path, job):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(job))
    tmp.replace(path)


def beat():
    try:
        HEALTH_FILE.touch()
    except OSError:
        pass


def main():
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    print("jarvis worker running", file=sys.stderr, flush=True)
    while not STOP:
        beat()
        try:
            if JOBS.is_dir():
                for p in sorted(JOBS.glob("*.json"),
                                key=lambda x: x.stat().st_mtime):
                    try:
                        job = json.loads(p.read_text())
                    except Exception:
                        continue
                    if job.get("executor") != "host" \
                            or job.get("status") != 0:
                        continue
                    name = job.get("name", "")
                    print(f"worker: picked job {job.get('id')} "
                          f"name={name}", file=sys.stderr, flush=True)
                    script = HOST_SCRIPTS / name
                    if not NAME_RE.match(name) or not script.is_file() \
                            or not script.stat().st_mode & 0o111:
                        job.update(status=2,
                                   output="unknown host script",
                                   rc=127, finished=time.time())
                        write_job(p, job)
                        continue
                    
                    # Verify script signature before execution
                    if not verify_script_signature(script):
                        job.update(status=2,
                                   output="script signature verification failed",
                                   rc=126, finished=time.time())
                        write_job(p, job)
                        continue
                    
                    # Verify script checksum before execution
                    if not verify_script_checksum(script):
                        job.update(status=2,
                                   output="script checksum verification failed",
                                   rc=125, finished=time.time())
                        write_job(p, job)
                        continue
                    # Host tools (rpm-ostree, systemd, flatpak) refuse to
                    # run when they detect a container env — present a
                    # host-like environment to allowlisted host scripts.
                    env = {k: v for k, v in os.environ.items()
                           if k != "container"}
                    try:
                        r = subprocess.run(
                            [str(script), *job.get("args", [])],
                            capture_output=True, text=True,
                            timeout=HOST_TIMEOUT, shell=False,
                            cwd=os.getenv("WORKDIR", "/"), env=env,
                        )
                        job.update(
                            status=1 if r.returncode == 0 else 2,
                            output=(r.stdout + r.stderr)[-MAX_OUTPUT:],
                            rc=r.returncode, finished=time.time(),
                        )
                    except subprocess.TimeoutExpired:
                        job.update(status=2, output="timeout",
                                   rc=124, finished=time.time())
                    except Exception as e:
                        job.update(status=2,
                                   output=str(e)[:MAX_OUTPUT],
                                   rc=1, finished=time.time())
                    write_job(p, job)
                    print(f"worker: finished job {job.get('id')} "
                          f"status={job.get('status')} rc={job.get('rc')}",
                          file=sys.stderr, flush=True)
                    if STOP:
                        break
        except Exception as e:
            print(f"worker error: {e}", file=sys.stderr, flush=True)
        if STOP:
            break
        time.sleep(POLL)
    print("jarvis worker stopped", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
