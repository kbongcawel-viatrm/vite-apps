FROM docker.io/library/python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# poller.py, .token, ssh/ and control/ are bind-mounted at runtime.
# Runs as container root -> host user kim under rootless Podman
# (already unprivileged; a uid-1000 user would lose bind-mount access).
CMD ["python", "-u", "/app/poller.py"]
