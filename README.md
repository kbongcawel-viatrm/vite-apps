# vite-ide

A Vite app that runs a hardened, password-protected [code-server](https://github.com/coder/code-server) (VS Code in the browser) instance, plus a small management UI.

## Architecture

```
browser ──> Vite UI (:5173)            management dashboard (status/start/stop)
browser ──> edge proxy (:8080)         security headers + login rate limit + WS
              └──> code-server (:18080, 127.0.0.1 only)  the actual editor
```

- **code-server** binds to `127.0.0.1:18080` — never directly reachable.
- The **edge proxy** (same Node process as the Vite plugin) is the only public surface. It adds CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, rate-limits `POST /login` (5/min/IP), and proxies HTTP + WebSocket traffic.
- Auth is `code-server --auth password` with the password passed via the `PASSWORD` env var — never on the command line.
- Telemetry and update checks are disabled; workspace trust is off; user data and extensions live under `.code-server-data/`.

## Setup

```bash
npm install
cp .env.example .env
# set a strong PASSWORD in .env, e.g.: openssl rand -base64 24
npm run dev        # UI on :5173, autostarts code-server
```

Open http://localhost:5173 — click **Start code-server**, then open the editor link (http://localhost:8080) and log in with `PASSWORD`.

The code-server binary is auto-installed to `vendor/code-server` on first start, or manually:

```bash
npm run install:code-server
```

## Configuration (.env)

| Var | Default | Purpose |
|---|---|---|
| `VITE_PORT` | 5173 | Management UI port |
| `EDGE_PORT` / `EDGE_BIND` | 8080 / 127.0.0.1 | Public proxy address |
| `CODE_SERVER_PORT` | 18080 | Internal code-server port (localhost only) |
| `PASSWORD` | — | **Required.** Editor login password |
| `CODE_SERVER_WORKSPACE` | ./workspace | Folder opened in the editor |
| `PUBLIC_EDITOR_URL` | http://localhost:8080 | URL shown in the UI |
| `CODE_SERVER_AUTOSTART` | 1 | Set `0` to disable autostart on `vite dev`/`preview` |

## Remote access (TLS required)

Never expose `EDGE_PORT` directly — it is plain HTTP. Terminate TLS in front of it:

```bash
caddy run --config deploy/Caddyfile   # see deploy/Caddyfile
```

then set `PUBLIC_EDITOR_URL=https://ide.example.com` in `.env`.

## Production

```bash
npm run build && npm run server   # serves dist/ + manages code-server, no Vite dev server
```

## Logs

- Edge/manager logs: Vite console
- code-server logs: `.code-server-data/logs/code-server.log` (+ `.err.log`)

## Security notes

- code-server grants full shell access to anyone who logs in — treat `PASSWORD` like a root password, keep it unique, and rotate it if exposed.
- `.env`, `vendor/`, `.code-server-data/`, `workspace/` are gitignored — never commit them.
- The CSP allows `'unsafe-inline'`/`'unsafe-eval'` because VS Code's web workbench requires them; everything else is locked down (`frame-ancestors 'none'`, `base-uri 'self'`, restrictive `Permissions-Policy`).
