# Adding a public hostname (standard pattern)

Every public service in this stack follows the same provisioning pattern.
Reference implementation: `jarvis.home-security.uk` + `jarvis-check.home-security.uk`
(workspace/jarvis).

## Naming convention

Each project gets **two** hostnames:

| Hostname | Purpose |
|---|---|
| `<project>.home-security.uk` | User-facing landing page / primary app |
| `<project>-check.home-security.uk` | Raw API / health-check endpoint (`/health`, `/run`) |

Both are gated by Cloudflare Access with the same policy. The `-check`
endpoint is what automation and curl clients call; the bare hostname is
what humans see in the browser and App Launcher.

Current deployments:

| Project | User hostname | Check hostname | Backend |
|---|---|---|---|
| jarvis | `jarvis.home-security.uk` | `jarvis-check.home-security.uk` | `127.0.0.1:8790` |
| file manager | `files.home-security.uk` | — (Caddy `:8443` only) | `127.0.0.1:5050` |

## Architecture

```
client ──> Cloudflare edge (Access SSO, if gated)
            └──> cloudflared (host netns, named tunnel "vite-apps")
                  └──> http://127.0.0.1:<port>  (container-published port)
```

cloudflared runs `network_mode: host`, so `127.0.0.1` inside it is the host —
publish app ports on `127.0.0.1` only; nothing else is reachable.

## Constants

| Item | Value |
|---|---|
| CF account | `home-sec-uk` = `7e1714b3d1b32fcaad4a5029c638cde4` |
| Tunnel | `vite-apps` = `832eb852-9827-45f2-97b2-0a5cd0c79a4e` (remotely-managed) |
| Zone | `home-security.uk` = `f5c4bcafdbbd8b96b8d9b584d0523535` |
| SSO IdP | `47fd24b7-cd7a-4797-bf3b-3af82d3c2793` |
| Access policy | "Allow home users" — same include/require as `files.` app |

## Steps

### 1. App container (compose.yaml)

Add a service under `services:` — build from `workspace/<name>/`, publish
`127.0.0.1:<port>:<port>`, add a `healthcheck`. See `jarvis:` for the pattern.
Secrets go in gitignored files (`.env`, `.token`) bind-mounted read-only.

```sh
podman-compose -f compose.yaml up -d --build <name>
```

### 2. Tunnel ingress (Cloudflare API)

PUT `/accounts/{acc}/cfd_tunnel/{tid}/configurations` — append a rule BEFORE
the `http_status:404` catch-all, preserving existing rules verbatim:

```json
{ "hostname": "<name>.home-security.uk", "service": "http://127.0.0.1:<port>" }
```

### 3. DNS record

POST `/zones/{zone}/dns_records`:

```json
{ "type": "CNAME", "name": "<name>.home-security.uk",
  "content": "832eb852-9827-45f2-97b2-0a5cd0c79a4e.cfargotunnel.com",
  "proxied": true, "ttl": 1 }
```

### 4. Access gate (required for anything user-facing)

POST `/accounts/{acc}/access/apps`, `type: "self_hosted"`, mirroring the
`files.home-security.uk` app:

- `domain` / `self_hosted_domains`: `<name>.home-security.uk`
- `session_duration`: `30m`, `app_launcher_visible`: true
- `allowed_idps`: `["47fd24b7-cd7a-4797-bf3b-3af82d3c2793"]`
- inline policy "Allow home users": `decision: allow`, `precedence: 1`,
  same four `include.email` entries and `require.login_method` as the
  `vite-apps` Access app (fetch it live — do not hardcode emails here)

### 5. Service tokens (only if non-browser clients need access)

Access gates browsers AND API clients. For curl/scripts/TV use, create a
service token (Access → Service Auth) and send:

```
CF-Access-Client-Id: <id>
CF-Access-Client-Secret: <secret>
```

### 6. Verify

```sh
curl -sI https://<name>.home-security.uk/health   # expect 302 -> cloudflareaccess.com
# after SSO or with service-token headers:
curl https://<name>.home-security.uk/health
```

## Notes

- Quick tunnels (`cloudflared tunnel --url`) are for throwaway testing only —
  never provision them as permanent hostnames.
- All CF mutations go through the Cloudflare MCP `execute` tool or the
  dashboard; agents must get operator approval first (AGENTS.md).
- `podman ps`/`podman-compose` do NOT work inside Toolbx containers — run
  them on the host OS.
