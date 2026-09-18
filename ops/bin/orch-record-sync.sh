#!/bin/bash
# Refresh the hosted record from this machine without placing secrets in launchd.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if ! ENV_FILES_OUTPUT="$(bun "$ROOT/shared/config-directory.ts" env-files)"; then
  exit 1
fi
ENV_ARGS=()
if [[ -n "$ENV_FILES_OUTPUT" ]]; then
  while IFS= read -r env_file; do
    ENV_ARGS+=(--env-file "$env_file")
  done <<< "$ENV_FILES_OUTPUT"
fi

bun ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} "$ROOT/orchestrator/src/cli/orch.ts" sync
sync_status=$?
bun ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} "$ROOT/orchestrator/src/cli/orch.ts" record publish
publish_status=$?

if (( sync_status != 0 || publish_status != 0 )); then
  exit 1
fi
