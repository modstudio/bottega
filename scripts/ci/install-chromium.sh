#!/bin/sh

set -u

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/ci/install-chromium.sh <package-dir>" >&2
  exit 2
fi

package_dir=$1

started_at=$(date +%s)

bun run --cwd "$package_dir" playwright install --with-deps chromium
status=$?

finished_at=$(date +%s)
seconds=$((finished_at - started_at))

if [ "$status" -eq 0 ]; then
  result=ok
else
  result=failed
fi

line="Install Chromium ($package_dir): $result in ${seconds}s"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '%s\n' "$line" >> "$GITHUB_STEP_SUMMARY"
else
  printf '%s\n' "$line"
fi

exit "$status"
