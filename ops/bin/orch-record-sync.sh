#!/bin/bash
# Refresh the hosted record from this machine without placing secrets in launchd.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$HOME/.claude/.env"

bun --env-file "$ENV_FILE" "$ROOT/orchestrator/src/cli/orch.ts" sync
sync_status=$?
bun --env-file "$ENV_FILE" "$ROOT/orchestrator/src/cli/orch.ts" record publish
publish_status=$?

if (( sync_status != 0 || publish_status != 0 )); then
  exit 1
fi
