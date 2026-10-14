#!/bin/bash
# Mechanical stale-note maintenance, followed by the curator only after its
# explicit setting has been enabled by an architect.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

"$ROOT/bin/bottega" note stale
stale_status=$?
"$ROOT/bin/bottega" note curate --scheduled
curator_status=$?

if (( stale_status != 0 || curator_status != 0 )); then
  exit 1
fi
