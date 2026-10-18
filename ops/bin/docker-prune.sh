#!/bin/bash
# Reclaim old Docker build cache and dangling images, run daily by launchd.
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

source "$(dirname "${BASH_SOURCE[0]}")/lib-logrotate.sh"
start_dated_log "$HOME/Library/Logs/docker-prune" 30

echo "===== $(date '+%Y-%m-%d %H:%M:%S') : starting ====="

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker prune skipped because Docker was unavailable."
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') : skipped ====="
  exit 0
fi

echo "===== Docker disk usage before prune ====="
docker system df

echo "===== Pruning build cache older than seven days ====="
docker builder prune --force --filter until=168h

echo "===== Pruning dangling images ====="
docker image prune --force

echo "===== Docker disk usage after prune ====="
docker system df

echo "===== $(date '+%Y-%m-%d %H:%M:%S') : done ====="
