#!/bin/bash
# Refresh the hosted record from this machine without placing secrets in launchd.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_RUNNER=(bun --no-env-file "$ROOT/shared/env-source.ts" run --)

"${ENV_RUNNER[@]}" bun --no-env-file "$ROOT/orchestrator/src/cli/orch.ts" sync
sync_status=$?
"${ENV_RUNNER[@]}" bun --no-env-file "$ROOT/orchestrator/src/cli/orch.ts" record publish
publish_status=$?

if (( sync_status != 0 || publish_status != 0 )); then
  exit 1
fi
