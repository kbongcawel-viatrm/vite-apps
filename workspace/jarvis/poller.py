#!/usr/bin/env python3
"""Poll-based trigger bridge: host pulls work from Android TV over SSH.

TV side:  ~/triggers/<name>.req  — first line: script name, rest: args
          Optionally ~/triggers/<name>.transcript with raw STT text.
Host side: enqueues into the local job queue (http://127.0.0.1:8790/run),
writes the job_id back to ~/triggers/<name>.job on the TV, removes .req.

Logging: poller.log next to this script — connection attempts, SSH
failures/backoff, and every trigger execution.
Rate limits: POLL backoff on SSH failure (exponential, capped),
MAX_JOBS_PER_MIN sliding window on enqueued jobs (env-tunable).
"""
import json
import logging
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path

BASE = Path(__file__).resolve().parent
TOKEN = (BASE / ".token").read_text().strip()
API = os.getenv("BRIDGE_API", "http://127.0.0.1:8790")
# Optional Cloudflare Access service token — required when BRIDGE_API
# points at the public https:// endpoint (TLS terminated at the edge).
CF_ID = os.getenv("CF_ACCESS_CLIENT_ID", "")
CF_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET", "")

# SSH Configuration - now configurable via environment variables
# SSH key path (default: ~/.ssh/jarvis_ed25519)
SSH_KEY_PATH = os.getenv("SSH_KEY_PATH", str(Path.home() / ".ssh" / "jarvis_ed25519"))
SSH_KEY = Path(SSH_KEY_PATH)

# Known hosts file path (default: ~/.ssh/known_hosts)
KNOWN_HOSTS_PATH = os.getenv("SSH_KNOWN_HOSTS", str(Path.home() / ".ssh" / "known_hosts"))
KNOWN_HOSTS = Path(KNOWN_HOSTS_PATH)

# SSH connection parameters
SSH_USER = os.getenv("SSH_USER", "u0_a71")
SSH_HOST = os.getenv("SSH_HOST", "192.168.2.246")
SSH_PORT = os.getenv("SSH_PORT", "8022")
SSH_CONNECT_TIMEOUT = os.getenv("SSH_CONNECT_TIMEOUT", "8")

# Control master directory
CM_DIR = Path(os.getenv("SSH_CONTROL_DIR", f"/run/user/{os.getuid()}/jarvis-ssh"))

# Validate and create directories with secure permissions
try:
    CM_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    SSH_KEY.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
except OSError:
    pass

# Validate SSH key exists and has proper permissions
if not SSH_KEY.exists():
    log.error(f"SSH key not found at: {SSH_KEY}")
    log.error(f"Expected path: {SSH_KEY_PATH}")
    log.error("For production: Use a secrets manager or ensure SSH keys are available.")
    log.error("For development: Create SSH keys or set SSH_KEY_PATH to the correct location.")
    sys.exit(1)

key_stat = SSH_KEY.stat()
key_mode = key_stat.st_mode & 0o777
if key_mode != 0o600:
    log.error(f"SSH key has insecure permissions: {oct(key_mode)}. Expected 0o600.")
    log.error(f"SSH key path: {SSH_KEY}")
    log.error("Fix permissions with: chmod 600 ~/.ssh/jarvis_ed25519")
    sys.exit(1)

# Validate known_hosts file
if not KNOWN_HOSTS.exists():
    log.warning(f"known_hosts file not found at: {KNOWN_HOSTS}")
    log.warning("SSH connections will fail with StrictHostKeyChecking=yes")
    log.warning("Create known_hosts file or set StrictHostKeyChecking=no (not recommended)")

# Build SSH command
SSH = [
    "ssh", "-i", str(SSH_KEY),
    "-o", f"ConnectTimeout={SSH_CONNECT_TIMEOUT}",
    "-o", "StrictHostKeyChecking=yes",
    "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "PreferredAuthentications=publickey",
    "-o", "PasswordAuthentication=no",
    "-o", "ControlMaster=auto",
    "-o", f"ControlPath={CM_DIR}/cm-%C",
    "-o", "ControlPersist=300",
    "-p", str(SSH_PORT), f"{SSH_USER}@{SSH_HOST}",
]
KILLSWITCH = Path(os.getenv("KILLSWITCH_FILE", str(BASE / "STOP")))
NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
POLL = float(os.getenv("POLL_INTERVAL", "2.0"))
MAX_JOBS_PER_MIN = int(os.getenv("MAX_JOBS_PER_MIN", "10"))
MAX_BACKOFF = float(os.getenv("MAX_BACKOFF", "120"))
LOG_FILE = BASE / "poller.log"
HEALTH_FILE = Path(os.getenv("HEALTH_FILE", "/tmp/poller-health"))

log = logging.getLogger("poller")
log.setLevel(logging.INFO)
_fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
_fh = RotatingFileHandler(LOG_FILE, maxBytes=512_000, backupCount=3)
_fh.setFormatter(_fmt)
log.addHandler(_fh)
_sh = logging.StreamHandler(sys.stderr)
_sh.setFormatter(_fmt)
log.addHandler(_sh)


def tv_sh(cmd):
    """Run a command on the TV. Returns (ok, stdout)."""
    try:
        r = subprocess.run([*SSH, cmd], capture_output=True, text=True,
                           timeout=25)
        return r.returncode == 0, r.stdout
    except Exception as e:
        return False, str(e)


def api_headers():
    headers = {"X-Token": TOKEN, "Content-Type": "application/json"}
    if API.startswith("https://"):
        if not CF_ID or not CF_SECRET:
            raise RuntimeError(
                "https API requires CF_ACCESS_CLIENT_ID/SECRET")
        headers["CF-Access-Client-Id"] = CF_ID
        headers["CF-Access-Client-Secret"] = CF_SECRET
    return headers


def enqueue(name, args, transcript):
    body = json.dumps({"name": name, "args": args,
                       "transcript": transcript}).encode()
    req = urllib.request.Request(
        f"{API}/run", data=body, method="POST",
        headers=api_headers())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


class RateLimiter:
    """Sliding-window limit on job enqueues per minute."""

    def __init__(self, max_per_min):
        self.max_per_min = max_per_min
        self.hits = deque()

    def allow(self):
        now = time.time()
        while self.hits and now - self.hits[0] > 60:
            self.hits.popleft()
        if len(self.hits) >= self.max_per_min:
            return False
        self.hits.append(now)
        return True


def close_ssh():
    """Gracefully close the shared SSH master connection, if any."""
    try:
        subprocess.run(
            [*SSH[:-1], "-O", "exit", SSH[-1]],
            capture_output=True, timeout=10)
        log.info("SSH master connection closed")
    except Exception as e:
        log.warning("SSH master close failed: %s", e)
    cleanup_sockets()


def cleanup_sockets():
    """Remove stale control sockets from the private control dir."""
    for sock in CM_DIR.glob("cm-*"):
        # A live master answers 'check'; anything else is stale.
        alive = subprocess.run(
            [*SSH[:-1], "-o", f"ControlPath={sock}",
             "-O", "check", SSH[-1]],
            capture_output=True, timeout=10).returncode == 0
        if not alive:
            try:
                sock.unlink()
                log.info("removed stale socket %s", sock.name)
            except OSError:
                pass


def shutdown(signum=None, frame=None):
    log.info("shutdown requested (signal=%s killswitch=%s)",
             signum, KILLSWITCH.exists())
    close_ssh()
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    cleanup_sockets()
    limiter = RateLimiter(MAX_JOBS_PER_MIN)
    fails = 0
    connected = False
    log.info("poller started api=%s poll=%.1fs max_jobs/min=%d",
             API, POLL, MAX_JOBS_PER_MIN)
    while True:
        try:
            HEALTH_FILE.touch()
        except OSError:
            pass
        if KILLSWITCH.exists():
            log.warning("killswitch file found: %s — stopping", KILLSWITCH)
            shutdown()
        ok, listing = tv_sh("ls ~/triggers/ 2>/dev/null")
        if not ok:
            fails += 1
            if connected or fails == 1 or fails % 10 == 0:
                log.warning("TV unreachable (fail #%d): %s",
                            fails, listing.strip()[:200])
            connected = False
            delay = min(POLL * (2 ** min(fails, 6)), MAX_BACKOFF)
            time.sleep(delay)
            continue
        if not connected:
            log.info("TV connected after %d failure(s)", fails)
            connected = True
        fails = 0

        for line in listing.splitlines():
            line = line.strip()
            if not line.endswith(".req"):
                continue
            name = line[:-4]  # <trigger>.req -> trigger name (file stem)
            if not NAME_RE.match(name):
                tv_sh(f"rm -f ~/triggers/{name}.req")
                log.warning("dropped invalid trigger filename: %r", name)
                continue
            ok, req = tv_sh(f"cat ~/triggers/{name}.req")
            if not ok:
                log.warning("failed to read trigger %s", name)
                continue
            lines = [l for l in req.splitlines() if l.strip()]
            script_name = lines[0].strip() if lines else name
            args = lines[1:21]
            ok, transcript = tv_sh(
                f"cat ~/triggers/{name}.transcript 2>/dev/null")
            transcript = transcript[:1000] if ok else ""
            if not NAME_RE.match(script_name):
                tv_sh(f"rm -f ~/triggers/{name}.req "
                      f"~/triggers/{name}.transcript")
                log.warning("dropped invalid script name: %r", script_name)
                continue
            if not limiter.allow():
                log.warning("rate limit hit — dropping %s", script_name)
                tv_sh(f"rm -f ~/triggers/{name}.req "
                      f"~/triggers/{name}.transcript")
                continue
            try:
                res = enqueue(script_name, args, transcript)
                jid = str(res.get("job_id", ""))
            except Exception as e:
                safe = re.sub(r"[^A-Za-z0-9 .:_-]", "", str(e))[:100]
                jid = f"error:{safe or 'unknown'}"
                log.error("enqueue failed for %s: %s", script_name, e)
            # jid is interpolated into a remote shell command — only allow
            # a real job id or a sanitized error string through.
            if not re.fullmatch(r"[0-9a-f]{12}|error:[A-Za-z0-9 .:_-]{1,100}",
                                jid):
                jid = "error:invalid-response"
                log.error("rejected unsafe job_id from API: %r",
                          res.get("job_id") if "res" in dir() else jid)
            if re.fullmatch(r"[0-9a-f]{12}", jid):
                log.info("enqueued %s -> job %s (trigger %s)",
                         script_name, jid, name)
            tv_sh(
                f"printf '%s' '{jid}' > ~/triggers/{name}.job; "
                f"rm -f ~/triggers/{name}.req ~/triggers/{name}.transcript"
            )
        time.sleep(POLL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("poller stopped")
