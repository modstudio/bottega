# Sourced helper: redirect this script's output to a dated log and prune old ones.
# Usage: LOG_DIR=/path/to/dir; RETAIN_DAYS=30; source lib-logrotate.sh
start_dated_log() {
  local dir="$1" retain="${2:-30}"
  mkdir -p "$dir"
  local logfile="$dir/$(date '+%Y-%m-%d').log"
  exec >>"$logfile" 2>&1
  # Prune logs older than N days (rotation).
  find "$dir" -maxdepth 1 -name '*.log' -type f -mtime +"$retain" -delete 2>/dev/null || true
}
