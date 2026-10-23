#!/bin/bash
# Work the spare-hands queue for one night; free-tier agents only.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

exec bun --no-env-file "$ROOT/shared/env-source.ts" run -- \
  "$ROOT/bin/bottega" machine spare run "$@"
