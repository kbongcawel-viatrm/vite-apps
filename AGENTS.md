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

- `workspace/file-manager/` — dufs file-manager image (`Dockerfile`, `entrypoint.sh`, `assets/`); mounts `ftp://192.168.2.1:21` via rclone/FUSE
- `workspace/ide/deploy/` — edge configs only: `Caddyfile.tunnel`, `cloudflared/config.yml`
- `compose.yaml` at repo root — unified podman-compose stack (`vite-apps` project): caddy + cloudflared + dufs
- `.env` at repo root holds secrets (`TUNNEL_TOKEN`) — never commit it; `workspace/file-manager/.env` holds `FTP_USER`/`FTP_PW`

## Common commands

```bash
podman-compose -f compose.yaml up -d        # start whole stack (repo root)
podman-compose -f compose.yaml ps|logs|down
podman-compose -f compose.yaml up -d|stop|start dufs   # file manager lifecycle
podman-compose -f compose.yaml up -d --build dufs      # rebuild image
```

Public URL (Cloudflare Tunnel): `https://files.home-security.uk` — gated by
Cloudflare Access SSO. No systemd units; everything is compose-managed.
