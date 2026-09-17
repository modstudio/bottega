#!/bin/sh
# shellcheck shell=ash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [dump-file]" >&2
  exit 2
fi

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "${script_dir}/../../.." && pwd)"
work_dir="$(mktemp -d)"
container="record-restore-check-$(date -u +%Y%m%d%H%M%S)-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM

if [ "$#" -eq 1 ]; then
  if [ ! -f "$1" ]; then
    echo "dump file does not exist: $1" >&2
    exit 1
  fi
  dump_path="$(CDPATH='' cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
else
  : "${R2_BUCKET:?R2_BUCKET is required when no dump file is given}"
  : "${R2_ENDPOINT:?R2_ENDPOINT is required when no dump file is given}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required when no dump file is given}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required when no dump file is given}"

  utility_image="record-backup-restore-check"
  docker build --file "$script_dir/Dockerfile" --tag "$utility_image" "$repo_root"
  newest_key="$(docker run --rm --entrypoint aws \
    -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=auto \
    "$utility_image" \
    --endpoint-url "$R2_ENDPOINT" s3api list-objects-v2 \
    --bucket "$R2_BUCKET" \
    --prefix record/ \
    --query 'sort_by(Contents, &LastModified)[-1].Key' \
    --output text)"
  if [ -z "$newest_key" ] || [ "$newest_key" = "None" ]; then
    echo "no dump exists under record/" >&2
    exit 1
  fi

  dump_path="${work_dir}/$(basename -- "$newest_key")"
  docker run --rm --entrypoint aws \
    -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=auto \
    -v "${work_dir}:/restore" \
    "$utility_image" \
    --endpoint-url "$R2_ENDPOINT" s3 cp \
    "s3://${R2_BUCKET}/${newest_key}" "/restore/$(basename -- "$newest_key")" \
    --only-show-errors
  echo "Downloaded ${newest_key}"
fi

docker run --detach --name "$container" \
  -e POSTGRES_PASSWORD=restore-check \
  postgres:18-alpine3.23 >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$container" pg_isready --username postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" != true ]; then
  echo "throwaway PostgreSQL did not become ready" >&2
  exit 1
fi

docker exec "$container" psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 \
  --command 'CREATE ROLE record_owner NOLOGIN' \
  --command 'CREATE ROLE record_actor NOLOGIN' \
  --command 'CREATE ROLE record_reader NOLOGIN' \
  --command 'CREATE DATABASE record_restore_check OWNER record_owner'
docker cp "$dump_path" "${container}:/tmp/record.dump"
docker exec "$container" pg_restore \
  --username postgres \
  --dbname record_restore_check \
  --exit-on-error \
  /tmp/record.dump

echo "Restored schema inventory:"
docker exec "$container" psql --username postgres --dbname record_restore_check \
  --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "SELECT 'tables|' || count(*) FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle') UNION ALL SELECT 'constraints|' || count(*) FROM information_schema.table_constraints WHERE constraint_schema IN ('public', 'drizzle') ORDER BY 1"

echo "Required table row counts:"
docker exec "$container" psql --username postgres --dbname record_restore_check \
  --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "SELECT 'run|' || count(*) FROM \"run\" UNION ALL SELECT 'run_score|' || count(*) FROM run_score UNION ALL SELECT 'doc|' || count(*) FROM doc UNION ALL SELECT 'doc_revision|' || count(*) FROM doc_revision UNION ALL SELECT 'project|' || count(*) FROM project ORDER BY 1"
