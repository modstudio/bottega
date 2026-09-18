#!/bin/bash
# Unattended morning refresh of local project instances via each project's
# built-in sync script (scripts/sync/main). Run daily by launchd.
#
# ONE checkout per project. Numbered clones are gone; parallel work happens in
# git worktrees under each repo's .claude/worktrees.
#
# Worktrees are deliberately NOT refreshed. A worktree belongs to one task and
# one session, and a 06:30 cron mutating fifteen of them behind the author's
# back would destroy more than it fixed.
#
# Each project is refreshed as deeply as its own sync script allows: --full
# when supported, --refresh otherwise, flag-less if neither. Detection is by
# reading the script, so a project gaining --full is picked up with no change
# here.
#
# One project failing never aborts the rest.

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Dated log + 30-day rotation.
source "$(dirname "${BASH_SOURCE[0]}")/lib-logrotate.sh"
start_dated_log "$HOME/Library/Logs/projects-refresh" 30

ORCH="$(cd "$(dirname "$0")/../.." && pwd)/bin/orch"

# The registered main checkout of each project, and nothing else.
INSTANCES=()
INSTANCE_NAMES=()
while IFS=$'\t' read -r _name _dir; do
  if [[ -d "$_dir" && -f "$_dir/scripts/sync/main" ]]; then
    INSTANCE_NAMES+=("$_name")
    INSTANCES+=("$_dir")
  else
    echo "SKIP: $_name has no scripts/sync/main at $_dir"
  fi
done < <("$ORCH" project list --json | python3 -c '
import json, sys
for project in json.load(sys.stdin):
    print("{}\t{}".format(project["name"], project["path"]))
')

# Deepest refresh the project's own sync script advertises. Asking the script
# what it supports beats a hardcoded per-project list, which is exactly what
# went stale last time.
deepest_flag() {
  local main="$1"
  if grep -q -- '--full' "$main" 2>/dev/null; then echo "--full"
  elif grep -q -- '--refresh' "$main" 2>/dev/null; then echo "--refresh"
  fi
}

echo "########## $(date '+%Y-%m-%d %H:%M:%S') : morning refresh starting ##########"

if (( ${#INSTANCES[@]} == 0 )); then
  echo "No registered project has scripts/sync/main - nothing to do."
  echo "########## $(date '+%Y-%m-%d %H:%M:%S') : morning refresh done ##########"
  exit 0
fi
echo "Discovered instances: ${INSTANCE_NAMES[*]}"

# Ensure the Docker daemon is up (a project's --refresh runs composer/npm/migrate
# in containers via `docker compose`, which fails if Docker Desktop isn't launched).
# Bounded wait so we never hang the whole job if Docker can't start.
ensure_docker() {
  if docker info >/dev/null 2>&1; then
    echo "Docker: already running"
    return 0
  fi
  echo "Docker: not running — launching Docker Desktop..."
  open -ga Docker 2>/dev/null || { echo "Docker: could not launch (open -ga Docker failed)"; return 1; }
  local waited=0
  while (( waited < 120 )); do
    if docker info >/dev/null 2>&1; then
      echo "Docker: ready after ${waited}s"
      return 0
    fi
    sleep 5; waited=$((waited + 5))
  done
  echo "Docker: still not ready after ${waited}s — refresh steps may fail"
  return 1
}

# Only bother if some instance will actually run --refresh.
for _dir in "${INSTANCES[@]}"; do
  if grep -q -- '--refresh' "$_dir/scripts/sync/main" 2>/dev/null; then
    echo; echo "===== docker preflight ====="
    ensure_docker || true
    break
  fi
done

for _index in "${!INSTANCES[@]}"; do
  inst="${INSTANCE_NAMES[$_index]}"
  dir="${INSTANCES[$_index]}"
  main="$dir/scripts/sync/main"
  echo
  echo "===== $inst ====="

  if [[ ! -x "$main" && ! -f "$main" ]]; then
    echo "  SKIP: no scripts/sync/main"
    continue
  fi

  flags=()
  _flag="$(deepest_flag "$main")"
  if [[ -n "$_flag" ]]; then
    flags=("$_flag")
  else
    echo "  note: neither --full nor --refresh supported; using flag-less default"
  fi

  echo "  running: bash scripts/sync/main ${flags[*]}"
  ( cd "$dir" && bash scripts/sync/main "${flags[@]}" )
  rc=$?
  case "$rc" in
    0) echo "  OK: $inst" ;;
    2) echo "  NOTE: $inst — nothing enabled to sync (exit 2)" ;;
    3) echo "  NOTE: $inst — first-time setup, config files created; needs configuring (exit 3)" ;;
    *) echo "  FAILED (exit $rc): $inst — continuing" ;;
  esac
done

echo
echo "--- orch metric (Claude tokens per shipped task) ---"
if [[ -x "$ORCH" ]]; then
  "$ORCH" metric collect --days 30 2>&1 | sed 's/^/  /'
else
  echo "  SKIP: orch is not executable at $ORCH"
fi

echo
echo "########## $(date '+%Y-%m-%d %H:%M:%S') : morning refresh done ##########"
