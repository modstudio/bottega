#!/usr/bin/env bash
# Install or refresh hub's collector agent.
#
# The collector runs whether or not a dashboard is open. Before this, `hub
# serve` was the only thing collecting, so the data was fresh exactly as long
# as someone had the page up — and stale by however long it had been closed.
#
# Safe to run repeatedly: bootout then bootstrap is the documented way to
# replace a definition, and `|| true` covers the first install when there is
# nothing loaded to remove.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_ROOT="$(bun --no-env-file "$SCRIPT_ROOT/shared/install-root.ts" root "$SCRIPT_ROOT/hub")"
CONCERN="$INSTALL_ROOT/hub"
STATE_HOME_ENV="$(bun --no-env-file "$INSTALL_ROOT/shared/state-directory.ts" environment)"
STATE_HOME="$(bun --no-env-file "$INSTALL_ROOT/shared/state-directory.ts" root)"
HUB_PORT="$(bun --no-env-file "$INSTALL_ROOT/shared/machine-config.ts" get hub.port)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs/hub"

# bootout is ASYNCHRONOUS. Bootstrapping straight after it races the old job's
# shutdown and fails with "Input/output error 5" — which, with set -e, aborted
# this script having already unloaded the collector and not yet reinstalled it.
# So: wait for the label to actually go, bounded, then bootstrap.
unload() {
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
  for _ in $(seq 1 40); do
    launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  echo "  warning: $1 did not unload within 10s" >&2
}

failed=0
for tmpl in "$CONCERN"/launchd/*.plist.template; do
  LABEL="$(basename "$tmpl" .plist.template)"
  TARGET="$AGENTS_DIR/$LABEL.plist"
  unload "$LABEL"
  # Render the resolved checkout or distribution root and its hub assets.
  sed -e "s#__INSTALL_ROOT__#${INSTALL_ROOT}#g" -e "s#__CONCERN__#${CONCERN}#g" \
      -e "s#__HOME__#${HOME}#g" \
      -e "s#__STATE_HOME_ENV__#${STATE_HOME_ENV}#g" \
      -e "s#__STATE_HOME__#${STATE_HOME}#g" \
      -e "s#__HUB_PORT__#${HUB_PORT}#g" \
      -e "s#__HUB_HOSTED_URL__#${HUB_HOSTED_URL:-}#g" "$tmpl" > "$TARGET"
  # One job failing must not leave the others uninstalled, which is exactly what
  # happened the first time this ran.
  if launchctl bootstrap "gui/$UID_NUM" "$TARGET" 2>/dev/null; then
    echo "installed $LABEL"
  else
    echo "FAILED to bootstrap $LABEL" >&2
    failed=1
  fi
done

# The obsolete report job has been failing with EX_CONFIG on every run
# since the move, pointing at a directory that holds nothing but a logs folder,
# and hub now does its work.
if launchctl print "gui/$UID_NUM/com.user.work-report" >/dev/null 2>&1; then
  unload com.user.work-report
  rm -f "$AGENTS_DIR/com.user.work-report.plist"
  echo "removed com.user.work-report (superseded; it had been failing EX_CONFIG)"
fi

echo "  logs: $HOME/Library/Logs/hub/"
for LABEL in com.user.hub-collect com.user.hub-serve; do
  launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null \
    | grep -E "^\sstate = " | sed "s#^#  $LABEL #" || echo "  $LABEL NOT LOADED"
done
exit $failed
