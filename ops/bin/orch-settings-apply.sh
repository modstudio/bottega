#!/bin/bash
# Apply hosted settings to this machine with the hosted-record environment available.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

exec bun --no-env-file "$ROOT/shared/env-source.ts" run -- \
  bun --no-env-file "$ROOT/orchestrator/src/cli/orch.ts" settings apply "$@"
