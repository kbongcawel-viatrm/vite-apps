FROM registry.access.redhat.com/ubi9/python-311:latest
USER 0
COPY podman_health.py /app/podman_health.py
# Rootless podman maps container root -> host uid 1000 (kim), which owns
# the socket. PODMAN_SOCK points at the mounted host podman socket; the
# script talks to the Podman REST API directly (stdlib only, no CLI).
ENV PODMAN_SOCK=/run/podman.sock \
    PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/app/podman_health.py"]
CMD ["--target", "http://gondar.home-security.uk:8080/ingest", "--interval", "60", "--filter", "vite-apps"]
