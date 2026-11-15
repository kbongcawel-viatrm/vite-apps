# Security roadmap — edge & identity posture

Status as of 2026-11-14. Captures what is deployed, what was considered and
rejected, and the planned hardening work.

## Current posture (deployed)

| Layer | Control |
|---|---|
| Network ingress | firewalld default-deny on host; nothing listens publicly. All access is outbound-initiated (cloudflared tunnel, SSH poller) |
| Edge identity | Cloudflare Access SSO on every public hostname (`files.`, `jarvis.`, `jarvis-check.`) — same "Allow home users" policy: 4 explicit emails + required login method, 30-min session |
| App authorization | `X-Token` shared secret on `/run`; allowlist of executables in `workspace/jarvis/scripts/` — no shell, no path traversal |
| Container isolation | Apps bind `127.0.0.1` only; rootless podman; per-service CPU/memory limits; healthchecks |
| Secrets | `.env`/`.token` gitignored, bind-mounted read-only; tunnel token in repo `.env` |

## Considered and rejected

- **App-level JWT / JIT tokens** — duplicates Cloudflare Access identity,
  session, and policy enforcement at the edge. Rejected as redundant
  complexity. Machine identity is covered by Access service tokens
  (`CF-Access-Client-Id/Secret`) instead.
- **Quick tunnels** (`trycloudflare.com`) — acceptable for throwaway tests
  only; never provisioned as permanent hostnames.

## Planned hardening

### Device posture (Cloudflare Access)

Require, in addition to SSO identity:

- **Device serial number** — WARP client posture attribute
- **WARP enrolled** — device must be connected to the Zero Trust org
- **Valid client certificate** — mTLS cert signed by designated CA
  (`common_name` / `fingerprint` posture attributes, or mutual TLS at edge)

Prerequisites: WARP client profiles, device enrollment, posture rule
configuration. Applies per Access app — `jarvis-check.` could be locked to
enrolled devices stricter than `files.`.

### Operational

- **Service tokens** for non-browser clients of `-check` endpoints
  (curl, automation) — created on demand per client
- **Audit logging** — Access logs auth decisions; add `/run` invocation
  logging in the bridge for an end-to-end trail
- **Rate limiting** at edge if `/run` ever sees abuse
- **Restricted SSH key** for TV→host (`ssh-gate.py` forced command exists;
  TV currently holds full-access `home-security` key — tighten if desired)
- **`poller.py` persistence** — currently `nohup`; needs systemd unit or
  containerization for restart-survival

## Design principle

Identity lives at the edge (Access); authorization lives in the app
(token + allowlist); the network assumes nothing (default-deny inbound,
outbound-only initiation). New identity checks are added as Access
`require` clauses — never inside application code.
