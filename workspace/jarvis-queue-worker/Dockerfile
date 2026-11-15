FROM docker.io/library/python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    JOBS_DIR=/data/jobs \
    HOST_SCRIPTS_DIR=/app/host-scripts \
    HEALTH_FILE=/tmp/worker-health \
    POLL_INTERVAL=2 \
    HOST_TIMEOUT=3600

WORKDIR /app

RUN mkdir -p /app/src /data

COPY src/worker.py /app/src/worker.py
COPY src/healthcheck.sh /app/src/healthcheck.sh

RUN chmod 0755 /app/src/healthcheck.sh

# Runs as container root -> host user kim under rootless Podman.
# cap_drop: ALL + no-new-privileges + read_only are set in compose.yaml.
CMD ["python", "-u", "/app/src/worker.py"]
