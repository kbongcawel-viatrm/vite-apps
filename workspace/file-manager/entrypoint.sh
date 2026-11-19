#!/bin/sh
set -e

mkdir -p /mnt/ftp

# Obscure the plaintext password so rclone can use it via env vars
OBSCURED_PW=$(rclone obscure "$FTP_PW")

# Mount ftp://10.1.29.1:21 in the background
rclone mount :ftp: /mnt/ftp \
  --ftp-host="${FTP_HOST:-10.1.29.1}" \
  --ftp-port="${FTP_PORT:-21}" \
  --ftp-user="$FTP_USER" \
  --ftp-pass="$OBSCURED_PW" \
  --vfs-cache-mode=writes \
  --allow-other \
  --daemon

# Serve the mounted FTP directory with dufs
exec dufs /mnt/ftp -p 5000 -A --assets /assets
