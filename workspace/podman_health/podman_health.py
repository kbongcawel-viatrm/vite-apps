#!/usr/bin/env python3
"""Podman container health agent — pushes status to the remote dashboard.

Runs inside the vite-apps podman-health container. Talks to the host's
rootless Podman REST API over the mounted unix socket (no podman CLI
needed inside the container), polls every INTERVAL seconds, and POSTs
each container's health to the dashboard's /ingest endpoint on the
monitoring host (https://gondar.home-security.uk).

Stdlib only. Safe for low-resource hosts.

Env:
    PODMAN_SOCK   unix socket path (default /run/user/1000/podman/podman.sock)
    TARGET_URL    dashboard ingest URL

Usage:
    python3 podman_health.py --target https://gondar.home-security.uk/ingest \
        --interval 60 --filter vite-apps
"""

import argparse
import http.client
import json
import os
import socket
import sys
import time
import urllib.request

PODMAN_API = "/v4.0.0/libpod/containers/json?all=true"


class UnixHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection over a unix domain socket."""

    def __init__(self, sock_path):
        super().__init__("localhost")
        self._sock_path = sock_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect(self._sock_path)


def podman_ps():
    """Return list of {name, status, up} for all containers via Podman API."""
    sock_path = os.environ.get(
        "PODMAN_SOCK", "/run/user/1000/podman/podman.sock")
    try:
        conn = UnixHTTPConnection(sock_path)
        conn.request("GET", PODMAN_API)
        resp = conn.getresponse()
        data = json.loads(resp.read())
        conn.close()
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    items = []
    for c in data:
        names = c.get("Names") or [""]
        name = names[0].lstrip("/")
        # API v4: "State" is a plain string ("running"/"exited"/...);
        # "Status" carries the health string ("healthy"/"unhealthy"/"")
        state = c.get("State")
        if isinstance(state, dict):
            state = (state.get("Status") or "").lower()
        else:
            state = (state or "").lower()
        status = (c.get("Status") or state or "").strip()
        status_l = status.lower()
        # negative states first: an exited container is DOWN even if its
        # last health result was "(healthy)"
        if state in ("exited", "stopped", "dead") or \
                "unhealthy" in status_l:
            up = False
        elif state == "running" or "up" in status_l or \
                "healthy" in status_l:
            up = True
        else:
            up = None  # created/configured/etc -> unknown
        items.append({"name": name, "status": status, "up": up})
    return items


def post(target, payload):
    try:
        req = urllib.request.Request(
            target,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST")
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True,
                    help="dashboard ingest URL, e.g. https://gondar.home-security.uk/ingest")
    ap.add_argument("--interval", type=int, default=60)
    ap.add_argument("--filter", default="",
                    help="only report containers whose name contains this")
    ap.add_argument("--once", action="store_true",
                    help="run a single poll and exit (for testing/cron)")
    args = ap.parse_args()

    def cycle():
        items = podman_ps()
        ok = 0
        for c in items:
            if args.filter and args.filter not in c["name"]:
                continue
            payload = {
                "name": f"pod:{c['name']}",
                "up": c["up"],
                "ms": None,
                "extra": {"status": c["status"]},
            }
            if post(args.target, payload):
                ok += 1
        print(f"[{time.strftime('%H:%M:%S')}] reported {ok} container(s)",
              flush=True)

    while True:
        cycle()
        if args.once:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
