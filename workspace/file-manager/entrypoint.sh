#!/bin/sh
# Mount the FTP share via `rclone mount` (FUSE), then serve it with dufs.
#
# Credentials come from workspace/file-manager/.env (env_file in compose.yaml):
#   FTP_USER, FTP_PW        required
#   FTP_HOST (default 192.168.2.1), FTP_PORT (default 21)  optional

set -u

: "${FTP_USER:?FTP_USER is not set — add it to workspace/file-manager/.env}"
: "${FTP_PW:?FTP_PW is not set — add it to workspace/file-manager/.env}"

FTP_HOST="${FTP_HOST:-192.168.2.1}"
FTP_PORT="${FTP_PORT:-21}"

export RCLONE_CONFIG_FTP_TYPE=ftp
export RCLONE_CONFIG_FTP_HOST="$FTP_HOST"
export RCLONE_CONFIG_FTP_PORT="$FTP_PORT"
export RCLONE_CONFIG_FTP_USER="$FTP_USER"
# rclone stores backend passwords obscured; obscure the plaintext at runtime
# so .env keeps the real password.
export RCLONE_CONFIG_FTP_PASS="$(rclone obscure "$FTP_PW")"

mkdir -p /data /tmp/rclone-cache

# dufs serves /data; it sees the FTP tree once rclone mounts over it.
dufs -A /data &

# rclone mount stays in the foreground: if the mount fails or drops, this
# process exits and podman restarts the container.
exec rclone mount ftp: /data \
  --vfs-cache-mode writes \
  --dir-cache-time 30s \
  --cache-dir /tmp/rclone-cache \
  --log-level INFO
