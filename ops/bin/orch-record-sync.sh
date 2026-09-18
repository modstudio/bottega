#!/bin/bash
# Refresh the hosted record from this machine without placing secrets in launchd.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_ARGS=()
while IFS= read -r env_file; do
  ENV_ARGS+=(--env-file "$env_file")
done < <(bun "$ROOT/shared/config-directory.ts" env-files)

bun "${ENV_ARGS[@]}" "$ROOT/orchestrator/src/cli/orch.ts" sync
sync_status=$?
bun "${ENV_ARGS[@]}" "$ROOT/orchestrator/src/cli/orch.ts" record publish
publish_status=$?

if (( sync_status != 0 || publish_status != 0 )); then
  exit 1
fi
