#!/bin/bash
# Install/refresh the launchd agents by rendering this project's plist templates
# with the current repo + home paths and (re)bootstrapping them. Location- and
# user-independent: clone anywhere, run ./install.sh. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The checkout itself. `bin/` holds each concern's binary and sits above ops/,
# so an agent that runs one needs the root rather than this directory.
ROOT="$(cd "$REPO/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs/brew-upgrade" "$HOME/Library/Logs/projects-refresh"

for tmpl in "$REPO"/launchd/*.plist.template; do
  label="$(basename "$tmpl" .plist.template)"

  if [[ "$label" == "com.user.local-model-tunnel" && -z "${LOCAL_MODEL_HOST:-}" ]]; then
    echo "skipped: $label (LOCAL_MODEL_HOST is unset)"
    continue
  fi
  if [[ "$label" == "com.user.local-model-tunnel" ]]; then
    mkdir -p "$HOME/Library/Logs/local-model-tunnel"
  fi

  target="$AGENTS_DIR/$label.plist"

  # Unload any existing version first (and drop a stale symlink from older installs).
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$target"

  # Render template -> real plist with absolute paths for this machine.
  #   __REPO__ -> this checkout, __HOME__ -> this user's home,
  #   __MODEL_HOST__ -> the configured SSH alias
  sed -e "s#__REPO__#${REPO}#g" -e "s#__ROOT__#${ROOT}#g" \
      -e "s#__HOME__#${HOME}#g" \
      -e "s#__MODEL_HOST__#${LOCAL_MODEL_HOST:-}#g" "$tmpl" > "$target"

  # Load it.
  launchctl bootstrap "gui/$UID_NUM" "$target"
  echo "installed: $label ($target)"
done

echo
echo "Active agents:"
launchctl list | grep -E 'brew-auto-upgrade|projects-morning-refresh|local-model-tunnel|orch-sweep' \
  || echo "  (none found)"
