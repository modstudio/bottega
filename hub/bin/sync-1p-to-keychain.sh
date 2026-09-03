#!/usr/bin/env bash
# Copy a value from 1Password into the macOS Keychain so the daily report
# can read it without needing `op` unlocked at cron time.
#
# Usage:
#   bin/sync-1p-to-keychain.sh op://Vault/Item/field [keychain-service-name]
#
# Example:
#   bin/sync-1p-to-keychain.sh op://Personal/Gmail/password work-report-smtp
#
# Re-run whenever the 1P value rotates.
set -euo pipefail

OP_REF="${1:-}"
SERVICE="${2:-work-report-smtp}"

if [ -z "$OP_REF" ]; then
  echo "usage: $0 op://Vault/Item/field [keychain-service-name]" >&2
  exit 2
fi

VALUE="$(op read "$OP_REF")"
if [ -z "$VALUE" ]; then
  echo "1Password returned an empty value for $OP_REF" >&2
  exit 1
fi

# Replace if already present, then add.
security delete-generic-password -s "$SERVICE" >/dev/null 2>&1 || true
security add-generic-password -s "$SERVICE" -a "$USER" -w "$VALUE"

echo "Stored 1Password value ($OP_REF) in keychain service '$SERVICE'."
echo "config.json can reference it as:  \"keychain:$SERVICE\""
