# Agent rules — vite-apps

## MCP mutations require approval

**Always prompt the operator for explicit approval before any destructive or
consequential change made through an MCP server** — including but not limited
to: DNS record create/update/delete, tunnel create/delete/config changes,
firewall/WAF/Access policy changes, deployments, deletions, and any other
write operation. Read-only calls (list, get, search, docs) may run without
approval. When in doubt, ask first.

## Project layout

- `workspace/mgmt-dashboard/` — Vite + TS management UI (npm workspace)
- `workspace/ide/` — code-server backend: `server/`, `scripts/`, `deploy/`, `compose.yaml`
- `.env` at repo root holds secrets (`PASSWORD`, `TUNNEL_TOKEN`, …) — never commit it
- Root `package.json` scripts delegate: `dev|build|preview` → dashboard, `server|deploy|install:code-server` → ide

## Common commands

```bash
npm install
npm run dev          # UI :5173 + edge proxy :8080 + code-server :18080
npm run build && npm run server   # production mode
npm run deploy       # build + app + podman-compose up -d (Caddy + cloudflared)
podman-compose -f workspace/ide/compose.yaml ps|logs|down
```

Public URLs (Cloudflare Tunnel): `https://ide.home-security.uk` (editor),
`https://manager.home-security.uk` (manager UI, PASSWORD-protected API).
