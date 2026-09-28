#!/bin/bash
# Install/refresh the launchd agents by rendering this installation's plist
# templates with absolute paths and (re)bootstrapping them. Idempotent.
set -euo pipefail

SCRIPT_CONCERN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_ROOT="$(cd "$SCRIPT_CONCERN/.." && pwd)"
INSTALL_ROOT="$(bun --no-env-file "$SCRIPT_ROOT/shared/install-root.ts" root "$SCRIPT_CONCERN")"
CONCERN="$INSTALL_ROOT/ops"
STATE_HOME_ENV="$(bun --no-env-file "$INSTALL_ROOT/shared/state-directory.ts" environment)"
STATE_HOME="$(bun --no-env-file "$INSTALL_ROOT/shared/state-directory.ts" root)"
MODEL_HOST="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get model_host.ssh_alias)"
TUNNEL_LOCAL_PORT="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get model_host.tunnel_local_port)"
TUNNEL_REMOTE_PORT="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get model_host.tunnel_remote_port)"
RECORD_TUNNEL_APP="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get record.tunnel_app)"
RECORD_TUNNEL_LOCAL_PORT="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get record.tunnel_local_port)"
RECORD_TUNNEL_REMOTE_PORT="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get record.tunnel_remote_port)"
FLYCTL="$(command -v flyctl || true)"
if ! ENV_FILES_OUTPUT="$(bun --no-env-file "$INSTALL_ROOT/shared/config-directory.ts" env-paths)"; then
  exit 1
fi
ENV_FILES=()
if [[ -n "$ENV_FILES_OUTPUT" ]]; then
  while IFS= read -r env_file; do
    ENV_FILES+=("$env_file")
  done <<< "$ENV_FILES_OUTPUT"
fi
if [[ -f "$INSTALL_ROOT/.git" ]]; then
  GIT_COMMON_DIR="$(git -C "$INSTALL_ROOT" rev-parse --path-format=absolute --git-common-dir)"
  MAIN_CHECKOUT="$(cd "$GIT_COMMON_DIR/.." && pwd)"
  echo "refusing to install launchd agents from linked worktree $INSTALL_ROOT; run $MAIN_CHECKOUT/ops/install.sh from the main checkout $MAIN_CHECKOUT" >&2
  exit 1
fi
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
# Provisional: today's stale runs were 16-40h old and ghost intervals 19h old,
# so four hours catches every measured case without hourly noise. Each pass
# records condition ages; revisit this after a week of that evidence.
PROVISIONAL_MONITOR_BACKSTOP_SECONDS=$((4 * 60 * 60))
FIX_DEFECT_BACKSTOP_SECONDS=$((12 * 60 * 60))

LOAD_WAIT_TRIES=20
LOAD_WAIT_SECONDS=0.25
FAILED_LABELS=()

wait_unloaded() {
  local tries=0
  while launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1; do
    ((++tries > LOAD_WAIT_TRIES)) && return 0
    sleep "$LOAD_WAIT_SECONDS"
  done
}

bootstrap_with_retry() {
  local tries=0
  until launchctl bootstrap "gui/$UID_NUM" "$1"; do
    ((++tries >= LOAD_WAIT_TRIES)) && return 1
    sleep "$LOAD_WAIT_SECONDS"
  done
}

remove_skipped_agent() {
  local label="$1"
  local reason="$2"
  local target="$AGENTS_DIR/$label.plist"
  local was_present=false

  if launchctl print "gui/$UID_NUM/$label" >/dev/null 2>&1 || [[ -e "$target" || -L "$target" ]]; then
    was_present=true
  fi
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  wait_unloaded "$label"
  rm -f "$target"

  if [[ "$was_present" == true ]]; then
    echo "removed existing agent; skipped: $label ($reason)"
  else
    echo "skipped: $label ($reason)"
  fi
}

mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs/brew-upgrade" "$HOME/Library/Logs/projects-refresh" \
  "$HOME/Library/Logs/orch-monitor" "$HOME/Library/Logs/orch-fix-defect" \
  "$HOME/Library/Logs/orch-canon-eval" "$HOME/Library/Logs/orch-canon-audit" \
  "$HOME/Library/Logs/orch-canon-mirror"

for tmpl in "$CONCERN"/launchd/*.plist.template; do
  label="$(basename "$tmpl" .plist.template)"

  if [[ "$label" == "com.user.local-model-tunnel" && -z "$MODEL_HOST" ]]; then
    remove_skipped_agent "$label" "model_host.ssh_alias is unset"
    continue
  fi
  if [[ "$label" == "com.user.local-model-tunnel" ]]; then
    mkdir -p "$HOME/Library/Logs/local-model-tunnel"
  fi
  if [[ "$label" == "com.user.record-tunnel" && -z "$RECORD_TUNNEL_APP" ]]; then
    remove_skipped_agent "$label" "record.tunnel_app is unset"
    continue
  fi
  if [[ "$label" == "com.user.record-tunnel" && -z "$FLYCTL" ]]; then
    remove_skipped_agent "$label" "flyctl is not on PATH"
    continue
  fi
  if [[ "$label" == "com.user.record-tunnel" ]]; then
    mkdir -p "$HOME/Library/Logs/record-tunnel"
  fi
  if [[ "$label" == "com.user.orch-record-sync" ]]; then
    has_env_file=false
    for env_file in ${ENV_FILES[@]+"${ENV_FILES[@]}"}; do
      [[ -f "$env_file" ]] && has_env_file=true
    done
    if [[ "$has_env_file" == false ]]; then
      remove_skipped_agent "$label" "env files are absent: ${ENV_FILES[*]-}"
      continue
    fi
  fi
  if [[ "$label" == "com.user.orch-record-sync" ]]; then
    mkdir -p "$HOME/Library/Logs/orch-record-sync"
  fi

  target="$AGENTS_DIR/$label.plist"

  # Unload any existing version first (and drop a stale symlink from older installs).
  # bootout returns before launchd has released the label; bootstrapping in that
  # window fails with EIO, so wait until the label is gone.
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  wait_unloaded "$label"
  rm -f "$target"

  # Render template -> real plist with absolute paths for this machine.
  #   __INSTALL_ROOT__ -> the resolved checkout or distribution root,
  #   __CONCERN__ -> the installed template owner's directory,
  #   __HOME__ -> this user's home,
  #   __MODEL_HOST__ -> the configured SSH alias, and tunnel port placeholders
  sed -e "s#__INSTALL_ROOT__#${INSTALL_ROOT}#g" -e "s#__CONCERN__#${CONCERN}#g" \
      -e "s#__HOME__#${HOME}#g" \
      -e "s#__STATE_HOME_ENV__#${STATE_HOME_ENV}#g" \
      -e "s#__STATE_HOME__#${STATE_HOME}#g" \
      -e "s#__MONITOR_BACKSTOP_SECONDS__#${PROVISIONAL_MONITOR_BACKSTOP_SECONDS}#g" \
      -e "s#__FIX_DEFECT_BACKSTOP_SECONDS__#${FIX_DEFECT_BACKSTOP_SECONDS}#g" \
      -e "s#__MODEL_HOST__#${MODEL_HOST}#g" \
      -e "s#__TUNNEL_LOCAL_PORT__#${TUNNEL_LOCAL_PORT}#g" \
      -e "s#__TUNNEL_REMOTE_PORT__#${TUNNEL_REMOTE_PORT}#g" \
      -e "s#__FLYCTL__#${FLYCTL}#g" \
      -e "s#__RECORD_TUNNEL_APP__#${RECORD_TUNNEL_APP}#g" \
      -e "s#__RECORD_TUNNEL_LOCAL_PORT__#${RECORD_TUNNEL_LOCAL_PORT}#g" \
      -e "s#__RECORD_TUNNEL_REMOTE_PORT__#${RECORD_TUNNEL_REMOTE_PORT}#g" "$tmpl" > "$target"

  # Load it. A label that still will not load is reported and the rest continue.
  if bootstrap_with_retry "$target"; then
    echo "installed: $label ($target)"
  else
    echo "FAILED to load: $label ($target); retry with: launchctl bootstrap gui/$UID_NUM $target" >&2
    FAILED_LABELS+=("$label")
  fi
done

echo
echo "Active agents:"
launchctl list | grep -E 'brew-auto-upgrade|projects-morning-refresh|local-model-tunnel|record-tunnel|orch-sweep|orch-monitor|orch-fix-defect|orch-canon-eval|orch-canon-audit|orch-canon-mirror|orch-record-sync|hub-note-maintenance' \
  || echo "  (none found)"

if ((${#FAILED_LABELS[@]})); then
  echo "not loaded: ${FAILED_LABELS[*]}" >&2
  exit 1
fi
