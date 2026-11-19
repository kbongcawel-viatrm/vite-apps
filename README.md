<div align="center">

<img src="assets/hero.svg" alt="vite-apps — file manager behind Cloudflare Access" width="100%"/>

# ⚡ vite-apps

**A dufs file manager over FTP**, exposed publicly through a rootless Podman stack: Caddy + Cloudflare Tunnel + Access SSO.

</div>

---

## 🏗️ Architecture

```text
browser ──> Cloudflare edge (Access SSO)
              └──> cloudflared ──> Caddy :8443 (TLS internal CA, 127.0.0.1 only)
                                     └── files.home-security.uk -> 127.0.0.1:5050 (dufs container)
```

- **dufs** runs as container `vite-apps_dufs_1`, publishing `127.0.0.1:5050 → :5000`.
- Inside the container, `entrypoint.sh` mounts `ftp://10.1.29.51:21` via rclone/FUSE to `/mnt/ftp`, then serves it with dufs.
- The dufs UI is vendored in `workspace/file-manager/assets/` — Atom-themed, with a Cloudflare Access logout link.
- All public traffic is gated solely by **Cloudflare Access** — nothing listens on LAN/public interfaces.

---

## 📁 Project structure

```text
vite-apps/
├── compose.yaml                  # podman-compose stack (rootless): caddy + cloudflared + dufs
├── .env / .env.example           # secrets (gitignored)
├── workspace/
│   ├── ide/deploy/               # Caddyfile.tunnel, cloudflared config
│   └── file-manager/             # dufs image (FTP via rclone)
│       ├── Dockerfile, entrypoint.sh, assets/
│       └── .env                  # FTP_USER / FTP_PW (gitignored)
└── assets/                       # README artwork
```

---

## 🚀 Deploy

```bash
podman-compose -f compose.yaml up -d        # start the whole stack
podman-compose -f compose.yaml up -d --build dufs   # rebuild the file manager image
```

Containers are **rootless only** — run `podman-compose` as your normal user, never with `sudo`.

| Command | Effect |
|---|---|
| `podman-compose -f compose.yaml ps` | Status |
| `podman-compose -f compose.yaml logs -f dufs` | Follow dufs logs |
| `podman-compose -f compose.yaml stop dufs` / `start dufs` | Toggle file manager |
| `podman-compose -f compose.yaml down` | Stop + remove all containers |

| URL | What |
|---|---|
| `https://files.home-security.uk` | dufs file manager over FTP (Access SSO) |
| `http://localhost:5050` | same service, local only |

---

## ⚙️ Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TUNNEL_TOKEN` | — | Cloudflare Tunnel token (compose `cloudflared` service, root `.env`) |
| `FTP_USER` / `FTP_PW` | — | FTP credentials (`workspace/file-manager/.env`) |
| `FTP_HOST` / `FTP_PORT` | `10.1.29.51` / `21` | Optional FTP endpoint overrides |

---

## 🔐 Security notes

- Public access is gated by **Cloudflare Access** (SSO via the `home-security-xyz` team domain — allow-listed emails) before any request reaches the tunnel.
- dufs binds inside the container; only `127.0.0.1:5050` is published on the host.
- `.env` and `workspace/file-manager/.env` are gitignored — **never commit secrets**.

---

<div align="center">

Made with ❤️ for self-hosted file access.

</div>
