#!/bin/bash
# Install/refresh the launchd agents by rendering this project's plist templates
# with the current repo + home paths and (re)bootstrapping them. Location- and
# user-independent: clone anywhere, run ./install.sh. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The checkout itself. `bin/` holds each concern's binary and sits above ops/,
# so an agent that runs one needs the root rather than this directory.
ROOT="$(cd "$REPO/.." && pwd)"
if [[ -f "$ROOT/.git" ]]; then
  GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
  MAIN_CHECKOUT="$(cd "$GIT_COMMON_DIR/.." && pwd)"
  echo "refusing to install launchd agents from linked worktree $ROOT; run $MAIN_CHECKOUT/ops/install.sh from the main checkout $MAIN_CHECKOUT" >&2
  exit 1
fi
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
# Provisional: today's stale runs were 16-40h old and ghost intervals 19h old,
# so four hours catches every measured case without hourly noise. Each pass
# records condition ages; revisit this after a week of that evidence.
PROVISIONAL_MONITOR_BACKSTOP_SECONDS=$((4 * 60 * 60))

mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs/brew-upgrade" "$HOME/Library/Logs/projects-refresh" \
  "$HOME/Library/Logs/orch-monitor" "$HOME/Library/Logs/orch-canon-eval"

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
      -e "s#__MONITOR_BACKSTOP_SECONDS__#${PROVISIONAL_MONITOR_BACKSTOP_SECONDS}#g" \
      -e "s#__MODEL_HOST__#${LOCAL_MODEL_HOST:-}#g" "$tmpl" > "$target"

  # Load it.
  launchctl bootstrap "gui/$UID_NUM" "$target"
  echo "installed: $label ($target)"
done

echo
echo "Active agents:"
launchctl list | grep -E 'brew-auto-upgrade|projects-morning-refresh|local-model-tunnel|orch-sweep|orch-monitor|orch-canon-eval|hub-note-maintenance' \
  || echo "  (none found)"
