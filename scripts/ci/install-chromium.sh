#!/bin/sh

set -u

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/ci/install-chromium.sh <package-dir>" >&2
  exit 2
fi

package_dir=$1

report_attempt() {
  attempt=$1
  result=$2
  seconds=$3
  line="Install Chromium ($package_dir): attempt $attempt $result in ${seconds}s"

  if [ "${GITHUB_STEP_SUMMARY+x}" = x ]; then
    printf '%s\n' "$line" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s\n' "$line"
  fi
}

run_attempt() {
  attempt=$1
  started_at=$(date +%s)

  timeout 150 bun run --cwd "$package_dir" playwright install --with-deps chromium
  status=$?

  finished_at=$(date +%s)
  seconds=$((finished_at - started_at))

  if [ "$status" -eq 0 ]; then
    result=ok
  elif [ "$status" -eq 124 ]; then
    result="timed out"
  else
    result=failed
  fi

  report_attempt "$attempt" "$result" "$seconds"
  attempt_result=$result
  return "$status"
}

if run_attempt 1; then
  exit 0
fi
first_result=$attempt_result

if run_attempt 2; then
  exit 0
fi
second_result=$attempt_result

printf 'Install Chromium (%s) failed after attempt 1 (%s) and attempt 2 (%s).\n' \
  "$package_dir" "$first_result" "$second_result" >&2
exit 1
