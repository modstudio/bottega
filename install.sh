#!/bin/sh
# Install a verified release without requiring a source checkout.
set -eu

REPOSITORY='modstudio/bottega'
PROJECT=${REPOSITORY##*/}
PRUNE=false
REQUESTED_VERSION=

fail() {
  echo "install failed: $*" >&2
  exit 1
}

usage() {
  echo 'usage: install.sh [version] [--prune]'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prune) PRUNE=true ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option $1; run with --help for usage" ;;
    *)
      [ -z "$REQUESTED_VERSION" ] || fail 'pass at most one version'
      REQUESTED_VERSION=$1
      ;;
  esac
  shift
done

command -v bun >/dev/null 2>&1 || fail 'Bun is required; install it from https://bun.com/docs/installation and retry'
command -v gh >/dev/null 2>&1 || fail 'GitHub CLI (gh) is required; install it from https://cli.github.com and retry'
gh auth status --hostname github.com >/dev/null 2>&1 || fail "gh must be authenticated to download the private repository; run 'gh auth login --hostname github.com' and retry"

if [ -n "$REQUESTED_VERSION" ]; then
  case "$REQUESTED_VERSION" in
    v*) TAG=$REQUESTED_VERSION ;;
    *) TAG=v$REQUESTED_VERSION ;;
  esac
else
  TAG=$(gh release view --repo "$REPOSITORY" --json tagName --jq .tagName) || fail 'could not resolve the latest release'
fi

case "$TAG" in
  v[0-9A-Za-z]*) ;;
  *) fail "release version must begin with an ASCII letter or number after v: $TAG" ;;
esac
case "$TAG" in
  *[!0-9A-Za-z.-]*) fail "release version contains unsupported characters: $TAG" ;;
esac

VERSION=${TAG#v}
ASSET="$PROJECT-$VERSION.tar.gz"
INSTALL_HOME=${BOTTEGA_HOME:-"$HOME/.local/share/$PROJECT"}
BIN_DIR="$HOME/.local/bin"
DESTINATION="$INSTALL_HOME/$VERSION"
CURRENT="$INSTALL_HOME/current"

mkdir -p "$INSTALL_HOME" "$BIN_DIR"
DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/$PROJECT-install.XXXXXX") || fail 'could not create a temporary download directory'
STAGE="$INSTALL_HOME/.install-$VERSION.$$"
cleanup() {
  rm -rf "$DOWNLOAD_DIR" "$STAGE"
}
trap cleanup EXIT HUP INT TERM

ARCHIVE="$DOWNLOAD_DIR/$ASSET"
gh release download "$TAG" --repo "$REPOSITORY" --pattern "$ASSET" --dir "$DOWNLOAD_DIR" || fail "could not download $ASSET from release $TAG"
[ -f "$ARCHIVE" ] || fail "release $TAG did not contain $ASSET"

EXPECTED_DIGEST=$(gh release view "$TAG" --repo "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"$ASSET\") | .digest") || fail "could not read the published digest for $ASSET"
case "$EXPECTED_DIGEST" in
  sha256:*) ;;
  *) fail "release $TAG has no SHA-256 digest for $ASSET; refusing to unpack an unverified download" ;;
esac
ACTUAL_DIGEST=$(bun -e 'const bytes = await Bun.file(process.argv[1]).arrayBuffer(); console.log(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))' "$ARCHIVE")
[ "sha256:$ACTUAL_DIGEST" = "$EXPECTED_DIGEST" ] || fail "digest mismatch for $ASSET; expected $EXPECTED_DIGEST but downloaded sha256:$ACTUAL_DIGEST"
tar -tzf "$ARCHIVE" >/dev/null 2>&1 || fail "$ASSET is truncated or is not a readable gzip tar archive"

mkdir "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE" || fail "could not unpack $ASSET"
EXTRACTED="$STAGE/$PROJECT-$VERSION"
[ -d "$EXTRACTED" ] || fail "$ASSET did not contain the expected $PROJECT-$VERSION directory"

validate_tree() {
  root=$1
  [ -x "$root/bin/orch" ] || return 1
  [ -x "$root/bin/hub" ] || return 1
  bun -e '
    const [path, version, project] = process.argv.slice(1)
    const manifest = await Bun.file(path).json()
    if (
      typeof manifest.name !== "string" ||
      manifest.name.toLowerCase() !== project ||
      manifest.version !== version ||
      typeof manifest.built !== "string" ||
      Number.isNaN(Date.parse(manifest.built)) ||
      typeof manifest.commit !== "string" ||
      !manifest.commit
    ) process.exit(1)
  ' "$root/.$PROJECT-dist.json" "$VERSION" "$PROJECT" >/dev/null 2>&1
}

validate_tree "$EXTRACTED" || fail "$ASSET does not contain a valid $VERSION distribution"
if [ -e "$DESTINATION" ]; then
  validate_tree "$DESTINATION" || fail "$DESTINATION already exists but is not a valid $VERSION installation; move it aside and retry"
  echo "kept existing verified installation: $DESTINATION"
else
  mv "$EXTRACTED" "$DESTINATION"
  echo "installed: $DESTINATION"
fi

if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  fail "$CURRENT exists and is not a symlink; move it aside and retry"
fi
CURRENT_NEXT="$INSTALL_HOME/.current.$$"
ln -s "$VERSION" "$CURRENT_NEXT"
bun -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$CURRENT_NEXT" "$CURRENT"
echo "current: $CURRENT -> $VERSION"

for command in orch hub; do
  link="$BIN_DIR/$command"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    fail "$link exists and is not a symlink; move it aside and retry"
  fi
  link_next="$BIN_DIR/.$command.$$"
  ln -s "$CURRENT/bin/$command" "$link_next"
  bun -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$link_next" "$link"
  echo "linked: $link -> $CURRENT/bin/$command"
done

if [ "$PRUNE" = true ]; then
  for candidate in "$INSTALL_HOME"/*; do
    [ "$candidate" != "$CURRENT" ] || continue
    [ -d "$candidate" ] || continue
    [ "$candidate" != "$DESTINATION" ] || continue
    [ -f "$candidate/.$PROJECT-dist.json" ] || continue
    rm -rf "$candidate"
    echo "pruned: $candidate"
  done
fi

case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) echo "add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
