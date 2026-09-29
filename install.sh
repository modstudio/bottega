#!/bin/sh
# Install a verified binary release. For local release testing only, set
# BOTTEGA_DOWNLOAD_BASE_URL to a server that mirrors the releases URL layout.
set -eu

REPOSITORY=modstudio/bottega
SUPPORTED='darwin-arm64, darwin-x64, linux-x64, linux-arm64'
REQUESTED_VERSION=

fail() {
  echo "install failed: $*" >&2
  exit 1
}

validate_version() {
  case "$1" in
    '') fail 'release version must not be empty' ;;
    [0-9A-Za-z]*) ;;
    *) fail "invalid release version $1" ;;
  esac
  case "$1" in
    *[!0-9A-Za-z.-]*|.|..) fail "invalid release version $1" ;;
  esac
}

usage() {
  cat <<'EOF'
usage: install.sh [version]

Installs the latest binary release, or the named version. Requires curl or
wget, tar, and sha256sum or shasum. BOTTEGA_DOWNLOAD_BASE_URL overrides the
GitHub releases base URL for testing.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option $1; run with --help for usage" ;;
    *)
      [ -z "$REQUESTED_VERSION" ] || fail 'pass at most one version'
      REQUESTED_VERSION=$1
      ;;
  esac
  shift
done

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "unsupported platform $(uname -s)-$(uname -m); supported: $SUPPORTED" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "unsupported platform $OS-$(uname -m); supported: $SUPPORTED" ;;
esac
TARGET=$OS-$ARCH

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q "$1" -O "$2"; }
else
  fail 'curl or wget is required'
fi
command -v tar >/dev/null 2>&1 || fail 'tar is required'
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail 'sha256sum or shasum is required'
fi

DOWNLOAD_ROOT=${BOTTEGA_DOWNLOAD_BASE_URL:-"https://github.com/$REPOSITORY/releases"}
case "$REQUESTED_VERSION" in
  '') RELEASE_URL=$DOWNLOAD_ROOT/latest/download ;;
  v*) VERSION=${REQUESTED_VERSION#v}; RELEASE_URL=$DOWNLOAD_ROOT/download/v$VERSION ;;
  *) VERSION=$REQUESTED_VERSION; RELEASE_URL=$DOWNLOAD_ROOT/download/v$VERSION ;;
esac
[ -z "$REQUESTED_VERSION" ] || validate_version "$VERSION"

DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/bottega-install.XXXXXX") || fail 'could not create temporary directory'
INSTALL_DIR=${BOTTEGA_INSTALL_DIR:-${XDG_BIN_HOME:-"$HOME/.local/bin"}}
STAGED_BINARY=
cleanup() {
  rm -rf "$DOWNLOAD_DIR"
  [ -z "$STAGED_BINARY" ] || rm -f "$STAGED_BINARY"
}
trap cleanup EXIT HUP INT TERM

SUMS=$DOWNLOAD_DIR/SHA256SUMS
download "$RELEASE_URL/SHA256SUMS" "$SUMS" || fail "could not download $RELEASE_URL/SHA256SUMS"
if [ -z "$REQUESTED_VERSION" ]; then
  PREFIX=bottega-
  SUFFIX=-$TARGET.tar.gz
  MATCHES=$(awk -v prefix="$PREFIX" -v suffix="$SUFFIX" '
    index($2, prefix) == 1 && substr($2, length($2)-length(suffix)+1) == suffix { print $2 }
  ' "$SUMS")
  [ "$(printf '%s\n' "$MATCHES" | awk 'NF { count++ } END { print count+0 }')" -eq 1 ] || fail "SHA256SUMS does not name exactly one latest artifact for $TARGET"
  ASSET=$MATCHES
  VERSION=${ASSET#bottega-}
  VERSION=${VERSION%-$TARGET.tar.gz}
  validate_version "$VERSION"
  [ "$ASSET" = "bottega-$VERSION-$TARGET.tar.gz" ] || fail "invalid latest artifact name $ASSET"
else
  ASSET=bottega-$VERSION-$TARGET.tar.gz
fi

EXPECTED=$(awk -v asset="$ASSET" '$2 == asset && $1 ~ /^[0-9a-fA-F]{64}$/ { print tolower($1) }' "$SUMS")
[ -n "$EXPECTED" ] || fail "SHA256SUMS has no valid entry for $ASSET"
[ "$(printf '%s\n' "$EXPECTED" | awk 'NF { count++ } END { print count+0 }')" -eq 1 ] || fail "SHA256SUMS has multiple entries for $ASSET"
ARCHIVE=$DOWNLOAD_DIR/$ASSET
download "$RELEASE_URL/$ASSET" "$ARCHIVE" || fail "could not download $ASSET"
ACTUAL=$(digest "$ARCHIVE")
[ "$ACTUAL" = "$EXPECTED" ] || fail "digest mismatch for $ASSET; expected $EXPECTED but downloaded $ACTUAL"

EXTRACTED=$DOWNLOAD_DIR/extracted
mkdir "$EXTRACTED"
tar -xzf "$ARCHIVE" -C "$EXTRACTED" || fail "could not unpack $ASSET"
[ -x "$EXTRACTED/bottega" ] || fail "$ASSET does not contain an executable bottega"
[ -f "$EXTRACTED/LICENSE" ] || fail "$ASSET does not contain LICENSE"
mkdir -p "$INSTALL_DIR"
STAGED_BINARY=$(mktemp "$INSTALL_DIR/.bottega-install.XXXXXX") || fail "could not create staging file in $INSTALL_DIR"
cp "$EXTRACTED/bottega" "$STAGED_BINARY"
chmod 755 "$STAGED_BINARY"
mv -f "$STAGED_BINARY" "$INSTALL_DIR/bottega"
echo "installed: $INSTALL_DIR/bottega ($VERSION)"

for command in orch hub; do
  link=$INSTALL_DIR/$command
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in
      "$INSTALL_DIR/bottega"|bottega) ;;
      *)
        echo "notice: skipped $link because it is not a symlink to $INSTALL_DIR/bottega" >&2
        continue
        ;;
    esac
  elif [ -e "$link" ]; then
    echo "notice: skipped $link because it is not a symlink to $INSTALL_DIR/bottega" >&2
    continue
  fi
  rm -f "$link"
  ln -s "$INSTALL_DIR/bottega" "$link"
  echo "linked: $link -> $INSTALL_DIR/bottega"
done

(unset ORCH_DB HUB_DB ORCH_DB_WRITE; "$INSTALL_DIR/bottega" orch migrate)
(unset ORCH_DB HUB_DB ORCH_DB_WRITE; "$INSTALL_DIR/bottega" hub migrate)

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
