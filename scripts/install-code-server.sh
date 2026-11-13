#!/usr/bin/env bash
# Downloads the official code-server release into ./vendor/code-server
# and links ./bin/code-server to its entrypoint.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT/vendor/code-server"
BIN_DIR="$ROOT/bin"
BIN="$BIN_DIR/code-server"
VERSION="${CODE_SERVER_VERSION:-latest}"

if [[ -x "$VENDOR_DIR/bin/code-server" && -z "${CODE_SERVER_VERSION:-}" ]]; then
  echo "code-server already installed at $VENDOR_DIR/bin/code-server ($("$VENDOR_DIR/bin/code-server" --version | head -1))"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ASSET_ARCH="amd64" ;;
  aarch64) ASSET_ARCH="arm64" ;;
  armv7l)  ASSET_ARCH="armhf" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/coder/code-server/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)"
fi
VERSION="${VERSION#v}"

TARBALL="code-server-${VERSION}-linux-${ASSET_ARCH}.tar.gz"
URL="https://github.com/coder/code-server/releases/download/v${VERSION}/${TARBALL}"

echo "Downloading $URL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/$TARBALL"
tar -xzf "$TMP/$TARBALL" -C "$TMP"

PKG_DIR="$TMP/code-server-${VERSION}-linux-${ASSET_ARCH}"
[[ -d "$PKG_DIR" ]] || PKG_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'code-server-*' | head -1)"

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR" "$BIN_DIR"
cp -a "$PKG_DIR/." "$VENDOR_DIR/"

# bin/code-server in the release is a wrapper that resolves ../lib relative to
# its own location, so a bare symlink into bin/ would break. Write a small
# wrapper that execs the real entrypoint inside vendor/.
cat > "$BIN" <<EOF
#!/usr/bin/env bash
exec "$VENDOR_DIR/bin/code-server" "\$@"
EOF
chmod +x "$BIN" "$VENDOR_DIR/bin/code-server"

"$BIN" --version | head -1
echo "Installed to $VENDOR_DIR"
