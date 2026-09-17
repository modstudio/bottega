#!/bin/sh
# shellcheck shell=ash
set -euo pipefail

: "${RECORD_BACKUP_DATABASE_URL:?RECORD_BACKUP_DATABASE_URL is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"

BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
case "$BACKUP_RETENTION_DAYS" in
  ''|*[!0-9]*)
    echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
    exit 1
    ;;
esac

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="record-${timestamp}.dump"
dump_path="${work_dir}/${filename}"
object_key="record/${filename}"

echo "Creating ${filename}"
pg_dump --dbname="$RECORD_BACKUP_DATABASE_URL" --format=custom --file="$dump_path"

local_size="$(wc -c < "$dump_path" | tr -d ' ')"
aws --endpoint-url "$R2_ENDPOINT" s3 cp "$dump_path" "s3://${R2_BUCKET}/${object_key}" --only-show-errors

remote_size="$({
  aws --endpoint-url "$R2_ENDPOINT" s3api list-objects-v2 \
    --bucket "$R2_BUCKET" \
    --prefix "$object_key" \
    --query "Contents[?Key=='${object_key}'].Size | [0]" \
    --output text
} | tr -d '\r')"

if [ "$remote_size" != "$local_size" ]; then
  echo "Upload verification failed for ${object_key}: local size ${local_size}, remote size ${remote_size}" >&2
  exit 1
fi
echo "Verified ${object_key} (${local_size} bytes)"

objects_json="${work_dir}/objects.json"
delete_keys="${work_dir}/delete-keys"
aws --endpoint-url "$R2_ENDPOINT" s3api list-objects-v2 \
  --bucket "$R2_BUCKET" \
  --prefix record/ \
  --output json > "$objects_json"

python3 - "$objects_json" "$BACKUP_RETENTION_DAYS" "$object_key" > "$delete_keys" <<'PY'
import datetime
import json
import sys

objects_path, retention_days, uploaded_key = sys.argv[1:]
with open(objects_path, encoding="utf-8") as source:
    objects = json.load(source).get("Contents", [])

if not objects:
    raise SystemExit("verified upload was absent from the record object listing")

newest = max(objects, key=lambda item: (item["LastModified"], item["Key"]))["Key"]
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=int(retention_days))
for item in objects:
    modified = datetime.datetime.fromisoformat(item["LastModified"].replace("Z", "+00:00"))
    key = item["Key"]
    if modified < cutoff and key not in {newest, uploaded_key}:
        print(key)
PY

while IFS= read -r expired_key; do
  [ -n "$expired_key" ] || continue
  aws --endpoint-url "$R2_ENDPOINT" s3api delete-object \
    --bucket "$R2_BUCKET" \
    --key "$expired_key" >/dev/null
  echo "Deleted expired object ${expired_key}"
done < "$delete_keys"
