# file-manager image: dufs web UI in front of an rclone FTP mount.
#
# Base is fedora-toolbox:44 (already pulled locally — the host's image policy
# rejects unsigned docker.io/debian pulls). dnf provides rclone + fuse3;
# the dufs binary is a static musl build from the GitHub release.
# (curlftpfs was rejected: it is incompatible with libcurl >= 8.17 —
# CURLOPT_KRB4LEVEL was removed upstream and the project is unmaintained.)

FROM registry.fedoraproject.org/fedora-toolbox:44

RUN dnf install -y --setopt=install_weak_deps=False rclone fuse3 ca-certificates \
 && dnf clean all

ADD https://github.com/sigoden/dufs/releases/download/v0.47.0/dufs-v0.47.0-x86_64-unknown-linux-musl.tar.gz /tmp/dufs.tar.gz
RUN tar -xzf /tmp/dufs.tar.gz -C /usr/bin \
 && chmod 0755 /usr/bin/dufs \
 && rm /tmp/dufs.tar.gz

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
