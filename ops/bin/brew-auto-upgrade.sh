#!/bin/bash
# Unattended Homebrew upgrade + cleanup, run daily by launchd.
# No TTY under launchd, so brew's [y/n] prompt is skipped automatically.

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOMEBREW_NO_ENV_HINTS=1

# Dated log + 30-day rotation.
source "$(dirname "${BASH_SOURCE[0]}")/lib-logrotate.sh"
start_dated_log "$HOME/Library/Logs/brew-upgrade" 30

BREW=/opt/homebrew/bin/brew

echo "===== $(date '+%Y-%m-%d %H:%M:%S') : starting ====="
"$BREW" update
"$BREW" upgrade
"$BREW" cleanup
echo "===== $(date '+%Y-%m-%d %H:%M:%S') : done ====="
