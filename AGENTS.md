# Agent rules — vite-apps

## Git pushes require operator approval

**The operator is the sole gate for all code pushes.** Never run
`git push` (or otherwise publish commits to a remote) without explicit
approval for that specific push. The operator performs pushes themselves
when ready; agents commit locally only.

## MCP mutations require approval

**Always prompt the operator for explicit approval before any destructive or
consequential change made through an MCP server** — including but not limited
to: DNS record create/update/delete, tunnel create/delete/config changes,
firewall/WAF/Access policy changes, deployments, deletions, and any other
write operation. Read-only calls (list, get, search, docs) may run without
approval. When in doubt, ask first.

## Project layout

- `workspace/file-manager/` — dufs file-manager image (`Dockerfile`, `entrypoint.sh`, `assets/`); mounts `ftp://10.1.29.51:21` via rclone/FUSE
- `workspace/ide/deploy/` — edge configs only: `Caddyfile.tunnel`, `cloudflared/config.yml`
- `compose.yaml` at repo root — unified podman-compose stack (`vite-apps` project): caddy + cloudflared + dufs
- `.env` at repo root holds secrets (`TUNNEL_TOKEN`) — never commit it; `workspace/file-manager/.env` holds `FTP_USER`/`FTP_PW`

## Everything runs as a container

**Every per-project process is a compose service — no exceptions.**
Rationale: manageability (one `podman-compose ps|logs|restart` surface),
standardization (same lifecycle for every component), portability
(the stack moves as a unit).

- New daemons/workers/pollers → new service in `compose.yaml`, never
  `nohup`, `&`, cron, or systemd units on the host
- Secrets live in gitignored files mounted read-only; runtime state in
  mounted `data/` dirs — never inside image layers
- Code that changes often is bind-mounted (`server.py` pattern) so
  updates need `restart`, not `--build`
- If a host process already exists for a project, containerize it and
  retire the host process — unaccounted processes are technical debt

## Common commands

```bash
podman-compose -f compose.yaml up -d        # start whole stack (repo root)
podman-compose -f compose.yaml ps|logs|down
podman-compose -f compose.yaml up -d|stop|start dufs   # file manager lifecycle
podman-compose -f compose.yaml up -d --build dufs      # rebuild image
```

Public URL (Cloudflare Tunnel): `https://files.home-security.uk` — gated by
Cloudflare Access SSO. No systemd units; everything is compose-managed.

## Public hostnames

Any new public hostname follows the standard pattern in
`docs/public-hostname.md` — compose service on `127.0.0.1`, tunnel ingress,
proxied CNAME to the tunnel, and a Cloudflare Access app with the shared
"Allow home users" policy. CF-side mutations require operator approval.

Security posture and planned hardening (device posture, service tokens,
JWT decision) are documented in `docs/security-roadmap.md`.

## Agent rules — process creation

- **Always inform the operator before creating a systemd unit or a container.**
  State what will be created, where it runs, and how to remove it — then wait
  for approval.
- **All services must run under uid 1000.** For containers this means
  rootless Podman only, and the in-container uid must map to host uid 1000
  (container `USER 0` under rootless maps to the host user — acceptable;
  `user: "1000:1000"` maps to a subuid and is NOT the host user).
- **Containers must use the default userns and default user** — no
  `userns_mode`, `user:`, or `--user` overrides. Under rootless Podman the
  default mapping already runs container root as host uid 1000.
