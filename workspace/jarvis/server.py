#!/usr/bin/env python3
"""Job-queue script runner for voice/remote triggers.

POST /run   {"name": "script", "args": [...], "transcript": "..."}
             -> {"job_id": "..."}   (enqueued, non-blocking)
GET  /jobs        -> recent jobs (newest first, max 50)
GET  /jobs/<id>   -> single job with status + output
GET  /health      -> {"ok": true}

Header on /run: X-Token: <shared secret>
Jobs are JSON files in ./data/jobs/ — no database.
Only runs executables inside ./scripts/ — no shell, no paths.
"""
import hashlib
import hmac
import json
import logging
import os
import re
import signal
import ssl
import subprocess
import sys
import threading
import time
from collections import deque, defaultdict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Configure structured JSON logging — must precede any module-level
# logger use (e.g. the token-file validation below).
logger = logging.getLogger("jarvis-server")
logger.setLevel(logging.INFO)


class JSONFormatter(logging.Formatter):
    """Custom formatter for JSON logs."""
    def format(self, record):
        log_entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }
        # Add extra fields if present
        for attr in ["client_ip", "method", "path", "status_code", "token_hash", "user_agent"]:
            if hasattr(record, attr):
                log_entry[attr] = getattr(record, attr)
        return json.dumps(log_entry)


# Add JSON handler to stdout (captured by Podman)
json_handler = logging.StreamHandler(sys.stdout)
json_handler.setFormatter(JSONFormatter())
logger.addHandler(json_handler)

# Add stderr handler for errors
stderr_handler = logging.StreamHandler(sys.stderr)
stderr_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
stderr_handler.addFilter(lambda record: record.levelno >= logging.WARNING)
logger.addHandler(stderr_handler)

BASE = Path(__file__).resolve().parent
SCRIPTS = BASE / "scripts"
HOST_SCRIPTS = BASE / "host-scripts"
JOBS = BASE / "data" / "jobs"
LISTEN = BASE / "data" / "listen"
TOKEN_FILE = BASE / ".token"

# Validate token file permissions and read token
if TOKEN_FILE.exists():
    token_stat = TOKEN_FILE.stat()
    # Check file permissions: should be 600 (owner read/write only)
    file_mode = token_stat.st_mode & 0o777
    if file_mode != 0o600:
        logger.error(f"Token file has insecure permissions: {oct(file_mode)}. Expected 0o600.")
        logger.error(f"Token file path: {TOKEN_FILE}")
        logger.error("Fix permissions with: chmod 600 workspace/jarvis/.token")
        sys.exit(1)
    # Check file ownership: should be owned by current user
    if token_stat.st_uid != os.getuid():
        logger.error(f"Token file owned by UID {token_stat.st_uid}, but running as UID {os.getuid()}")
        logger.error(f"Token file path: {TOKEN_FILE}")
        sys.exit(1)
    TOKEN = TOKEN_FILE.read_text().strip()
else:
    TOKEN = ""
    logger.error("Token file not found. Server will not accept authenticated requests.")

PORT = 8790
HTTPS_PORT = int(os.getenv("HTTPS_PORT", "8791"))

# SSL/TLS Configuration
# WARNING: Self-signed certificates are NOT suitable for production!
# For production, use CA-signed certificates and set SSL_ENABLED=true
# Do NOT enable SSL_ENABLED without proper certificates from a trusted CA
SSL_CERTFILE = os.getenv("SSL_CERTFILE", str(BASE / "ssl" / "cert.pem"))
SSL_KEYFILE = os.getenv("SSL_KEYFILE", str(BASE / "ssl" / "key.pem"))
SSL_ENABLED = os.getenv("SSL_ENABLED", "false").lower() == "true"

# Production safety check
if SSL_ENABLED:
    logger.warning("SSL_ENABLED is TRUE but self-signed certificates are NOT suitable for production!")
    logger.warning("For production use, obtain CA-signed certificates and ensure proper configuration.")
    logger.warning("Self-signed certificates will cause trust errors in clients.")

NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
MAX_OUTPUT = 8000
MAX_BODY = 1_000_000

# Rate limiting configuration
MAX_JOBS_PER_MINUTE_PER_TOKEN = 10
MAX_JOBS_PER_MINUTE_GLOBAL = 100

# Job retention policy configuration
# Maximum age of jobs in hours (default: 24 hours)
MAX_JOB_AGE_HOURS = int(os.getenv("MAX_JOB_AGE_HOURS", "24"))
# Maximum number of jobs to keep (default: 1000)
MAX_JOBS_TO_KEEP = int(os.getenv("MAX_JOBS_TO_KEEP", "1000"))
# Cleanup interval in minutes (default: 60 minutes)
JOB_CLEANUP_INTERVAL = int(os.getenv("JOB_CLEANUP_INTERVAL", "60"))


class RateLimiter:
    """Sliding window rate limiter."""
    def __init__(self, max_per_min):
        self.max = max_per_min
        self.window = deque()

    def allow(self):
        """Check if request is allowed. Returns True if allowed, False if rate limited."""
        now = time.time()
        # Remove old entries (older than 60 seconds)
        while self.window and self.window[0] <= now - 60:
            self.window.popleft()
        # Check if at limit
        if len(self.window) >= self.max:
            return False
        # Add current request
        self.window.append(now)
        return True


# Rate limiters: per-token and global
rate_limiters = defaultdict(lambda: RateLimiter(MAX_JOBS_PER_MINUTE_PER_TOKEN))
global_limiter = RateLimiter(MAX_JOBS_PER_MINUTE_GLOBAL)


def authed(handler):
    return hmac.compare_digest(
        handler.headers.get("X-Token", ""), TOKEN)


def rate_ok(handler):
    """Sliding-window limits on mutating endpoints only — GET polling
    (job status, listen queue) must not consume the job-creation budget."""
    token = handler.headers.get("X-Token", "")
    if not global_limiter.allow():
        logger.warning("Global rate limit exceeded", extra={
            "client_ip": handler.client_address[0],
            "token_hash": hashlib.sha256(token.encode()).hexdigest()[:16] if token else "none",
        })
        return False
    if not rate_limiters[token].allow():
        logger.warning("Per-token rate limit exceeded", extra={
            "client_ip": handler.client_address[0],
            "token_hash": hashlib.sha256(token.encode()).hexdigest()[:16] if token else "none",
        })
        return False
    return True


def job_path(jid):
    return JOBS / f"{jid}.json"


def read_job(jid):
    try:
        return json.loads(job_path(jid).read_text())
    except Exception:
        return None


def write_job(job):
    JOBS.mkdir(parents=True, exist_ok=True)
    tmp = job_path(job["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(job))
    tmp.replace(job_path(job["id"]))


def cleanup_old_jobs():
    """Clean up old job files based on retention policy."""
    if not JOBS.is_dir():
        return
    
    now = time.time()
    max_age_seconds = MAX_JOB_AGE_HOURS * 3600
    deleted_count = 0
    
    # Get all job files sorted by modification time (oldest first)
    job_files = sorted(JOBS.glob("*.json"), key=lambda p: p.stat().st_mtime)
    
    for job_file in job_files:
        # Check if we've deleted enough jobs
        if deleted_count >= MAX_JOBS_TO_KEEP:
            break
        
        # Check if job is too old
        file_age = now - job_file.stat().st_mtime
        if file_age > max_age_seconds:
            try:
                job_file.unlink()
                deleted_count += 1
                logger.info(f"Cleaned up old job: {job_file.name} (age: {file_age:.1f}s)")
            except Exception as e:
                logger.error(f"Failed to delete old job {job_file.name}: {e}")
    
    if deleted_count > 0:
        logger.info(f"Job cleanup: deleted {deleted_count} old jobs")


def start_cleanup_thread():
    """Start background thread for periodic job cleanup."""
    def cleanup_loop():
        while True:
            try:
                cleanup_old_jobs()
            except Exception as e:
                logger.error(f"Job cleanup error: {e}")
            time.sleep(JOB_CLEANUP_INTERVAL * 60)
    
    thread = threading.Thread(target=cleanup_loop, daemon=True)
    thread.start()
    logger.info(f"Started job cleanup thread (interval: {JOB_CLEANUP_INTERVAL} minutes)")


def validate_ssl_certificates():
    """Validate SSL certificates exist and are valid. Fails securely if not."""
    cert_file = Path(SSL_CERTFILE)
    key_file = Path(SSL_KEYFILE)
    
    # In production, we should NEVER auto-generate self-signed certs
    # If certificates don't exist and SSL is enabled, FAIL SECURELY
    if not cert_file.exists() or not key_file.exists():
        logger.error("SSL certificates not found!")
        logger.error(f"Expected certificate: {cert_file}")
        logger.error(f"Expected key: {key_file}")
        logger.error("For production: Obtain CA-signed certificates from a trusted authority.")
        logger.error("For development: Set SSL_ENABLED=false or provide valid certificates.")
        return False
    
    # Validate certificate and key
    try:
        # Check file permissions
        cert_stat = cert_file.stat()
        key_stat = key_file.stat()
        
        if key_stat.st_mode & 0o777 != 0o600:
            logger.error(f"SSL key has insecure permissions: {oct(key_stat.st_mode & 0o777)}")
            return False
        
        if cert_stat.st_mode & 0o777 != 0o644:
            logger.error(f"SSL certificate has insecure permissions: {oct(cert_stat.st_mode & 0o777)}")
            return False
        
        logger.info(f"SSL certificates validated: {cert_file}")
        return True
    except Exception as e:
        logger.error(f"Error validating SSL certificates: {e}")
        return False


def start_https_server():
    """Start HTTPS server if SSL is enabled."""
    if not SSL_ENABLED:
        return None
    
    # Validate SSL certificates - FAIL SECURELY if invalid
    if not validate_ssl_certificates():
        logger.error("HTTPS server NOT started: Invalid or missing SSL certificates")
        logger.error("Set SSL_ENABLED=false to disable HTTPS, or provide valid CA-signed certificates")
        return None
    
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=SSL_CERTFILE, keyfile=SSL_KEYFILE)
        context.set_ciphers("ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384")
        context.options |= ssl.OP_NO_SSLv2
        context.options |= ssl.OP_NO_SSLv3
        context.options |= ssl.OP_NO_TLSv1
        context.options |= ssl.OP_NO_TLSv1_1
        
        https_server = ThreadingHTTPServer(("0.0.0.0", HTTPS_PORT), Handler)
        https_server.socket = context.wrap_socket(https_server.socket, server_side=True)
        
        logger.info(f"HTTPS server starting on :{HTTPS_PORT} with validated certificates")
        return https_server
    except Exception as e:
        logger.error(f"Failed to start HTTPS server: {e}")
        return None


def listen_path(lid):
    return LISTEN / f"{lid}.json"


def read_listen(lid):
    try:
        return json.loads(listen_path(lid).read_text())
    except Exception:
        return None


def write_listen(req):
    LISTEN.mkdir(parents=True, exist_ok=True)
    tmp = listen_path(req["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(req))
    tmp.replace(listen_path(req["id"]))


def next_listen_request():
    """Oldest pending listen request, or None."""
    if not LISTEN.is_dir():
        return None
    pending = []
    for p in LISTEN.glob("*.json"):
        try:
            r = json.loads(p.read_text())
        except Exception:
            continue
        if r.get("status") == 0:
            pending.append(r)
    if not pending:
        return None
    return min(pending, key=lambda r: r.get("created", 0))


def enqueue(name, args, transcript, executor="container"):
    jid = hashlib.sha256(
        f"{name}|{'|'.join(args)}|{time.time()}".encode()
    ).hexdigest()[:12]
    job = {
        "id": jid, "name": name, "args": args,
        "transcript": transcript[:1000],
        "executor": executor,
        "status": 0, "output": "", "rc": None,
        "created": time.time(), "finished": None,
    }
    write_job(job)
    return job


def worker():
    while True:
        try:
            queued = sorted(
                JOBS.glob("*.json"),
                key=lambda p: p.stat().st_mtime,
            )
            for p in queued:
                try:
                    job = json.loads(p.read_text())
                except Exception:
                    continue
                if job.get("executor") == "host" \
                        or job.get("status") != 0:
                    continue
                name = job.get("name", "")
                script = SCRIPTS / name
                if not NAME_RE.match(name) or not script.is_file() \
                        or not script.stat().st_mode & 0o111:
                    job.update(status=2, output="unknown script",
                               rc=127, finished=time.time())
                    write_job(job)
                    continue
                job["status"] = 0
                write_job(job)
                try:
                    r = subprocess.run(
                        [str(script), *job.get("args", [])],
                        capture_output=True, text=True, timeout=60,
                        shell=False, cwd=str(script.parent),
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
                    job.update(status=2, output=str(e)[:MAX_OUTPUT],
                               rc=1, finished=time.time())
                write_job(job)
        except Exception as e:
            print(f"worker error: {e}", file=sys.stderr, flush=True)
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def _get_token_hash(self):
        """Get hashed token for logging (not the actual token)."""
        token = self.headers.get("X-Token", "")
        if token:
            import hashlib
            return hashlib.sha256(token.encode()).hexdigest()[:16]
        return "none"

    def _log_request(self, status_code):
        """Log request details with structured JSON."""
        logger.info("", extra={
            "client_ip": self.client_address[0],
            "method": self.command,
            "path": self.path,
            "status_code": status_code,
            "token_hash": self._get_token_hash(),
            "user_agent": self.headers.get("User-Agent", "")[:100],
        })

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        # Log the response
        self._log_request(code)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if self.path == "/scripts":
            names = set()
            for d in (SCRIPTS, HOST_SCRIPTS):
                if d.is_dir():
                    names.update(
                        p.name for p in d.iterdir()
                        if p.is_file() and p.stat().st_mode & 0o111
                        and NAME_RE.match(p.name)
                    )
            return self._send(200, {"scripts": sorted(names)})
        if self.path in ("/jobs",) or self.path.startswith("/jobs/"):
            if not authed(self):
                logger.warning("Failed authentication attempt", extra={
                    "client_ip": self.client_address[0],
                    "method": self.command,
                    "path": self.path,
                    "status_code": 403,
                    "token_hash": self._get_token_hash(),
                })
                return self._send(403, {"error": "bad token"})
        if self.path == "/jobs":
            jobs = []
            if JOBS.is_dir():
                for p in sorted(JOBS.glob("*.json"),
                                key=lambda x: x.stat().st_mtime,
                                reverse=True)[:50]:
                    try:
                        j = json.loads(p.read_text())
                    except Exception:
                        continue
                    jobs.append({k: j.get(k) for k in (
                        "id", "name", "status", "rc",
                        "created", "finished")})
            return self._send(200, {"jobs": jobs})
        m = re.fullmatch(r"/jobs/([0-9a-f]{12})", self.path)
        if m:
            job = read_job(m.group(1))
            return self._send(200, {"job": job}) if job \
                else self._send(404, {"error": "not found"})
        if self.path == "/listen":
            if not authed(self):
                return self._send(403, {"error": "bad token"})
            req = next_listen_request()
            return self._send(200, {"request": req})
        m = re.fullmatch(r"/listen/([0-9a-f]{12})", self.path)
        if m:
            req = read_listen(m.group(1))
            return self._send(200, {"request": req}) if req \
                else self._send(404, {"error": "not found"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/run", "/listen") \
                and not re.fullmatch(r"/listen/[0-9a-f]{12}/result",
                                     self.path):
            return self._send(404, {"error": "not found"})
        if not authed(self):
            logger.warning("Failed authentication attempt", extra={
                "client_ip": self.client_address[0],
                "method": self.command,
                "path": self.path,
                "status_code": 403,
                "token_hash": self._get_token_hash(),
            })
            return self._send(403, {"error": "bad token"})
        if not rate_ok(self):
            return self._send(429, {"error": "rate limited"})
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._send(400, {"error": "bad request"})
        if length > MAX_BODY:
            return self._send(413, {"error": "body too large"})
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})

        if self.path == "/listen":
            note = str(data.get("note", ""))[:500]
            lid = hashlib.sha256(
                f"listen|{note}|{time.time()}".encode()
            ).hexdigest()[:12]
            write_listen({
                "id": lid, "note": note, "status": 0,
                "transcript": "", "job_id": "",
                "created": time.time(), "finished": None,
            })
            return self._send(202, {"id": lid, "status": 0})

        m = re.fullmatch(r"/listen/([0-9a-f]{12})/result", self.path)
        if m:
            req = read_listen(m.group(1))
            if not req:
                return self._send(404, {"error": "not found"})
            req.update(
                status=1,
                transcript=str(data.get("transcript", ""))[:1000],
                job_id=str(data.get("job_id", ""))[:64],
                finished=time.time(),
            )
            write_listen(req)
            return self._send(200, {"id": req["id"], "status": 1})

        name = data.get("name", "")
        args = data.get("args", [])
        transcript = data.get("transcript", "")
        if not NAME_RE.match(name) or not isinstance(args, list) \
                or not isinstance(transcript, str):
            return self._send(400, {"error": "bad request"})
        if not all(isinstance(x, str) and len(x) <= 500 for x in args):
            return self._send(400, {"error": "bad args"})

        executor = "container"
        script = SCRIPTS / name
        if not (script.is_file() and script.stat().st_mode & 0o111):
            script = HOST_SCRIPTS / name
            if script.is_file() and script.stat().st_mode & 0o111:
                executor = "host"
            else:
                return self._send(404, {"error": "unknown script"})

        job = enqueue(name, args, transcript, executor)
        self._send(202, {"job_id": job["id"], "status": 0})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("create .token first")
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    JOBS.mkdir(parents=True, exist_ok=True)
    
    # Start job cleanup thread
    start_cleanup_thread()
    
    # Start HTTPS server if enabled
    https_server = start_https_server()
    
    threading.Thread(target=worker, daemon=True).start()
    
    if SSL_ENABLED and https_server:
        print(f"jarvis bridge on HTTP :{PORT} and HTTPS :{HTTPS_PORT}")
        # Start HTTPS server in a separate thread
        threading.Thread(target=https_server.serve_forever, daemon=True).start()
    else:
        print(f"jarvis bridge on :{PORT}")
    
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
