#!/bin/sh

set -eu

python - <<'PY'
import os
import sys
import time
from pathlib import Path

health_file = Path(os.getenv("HEALTH_FILE", "/tmp/worker-health"))
max_age = int(os.getenv("HEALTH_MAX_AGE", "120"))

try:
    if not health_file.is_file():
        raise RuntimeError("Worker heartbeat file is missing")
    age = time.time() - health_file.stat().st_mtime
    if age > max_age:
        raise RuntimeError(f"Worker heartbeat is stale: {age:.0f}s")
    if age < -60:
        raise RuntimeError("Worker heartbeat timestamp is invalid")
except Exception as error:
    print(f"UNHEALTHY: {error}", file=sys.stderr)
    sys.exit(1)

print("HEALTHY: worker heartbeat is fresh")
PY
