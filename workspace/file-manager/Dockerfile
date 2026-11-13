FROM docker.io/sigoden/dufs:latest AS dufs-bin

FROM docker.io/rclone/rclone:latest
COPY --from=dufs-bin /bin/dufs /usr/local/bin/dufs
RUN apk add --no-cache fuse3
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
