#!/bin/sh
# shellcheck shell=ash
set -eu

REHEARSAL_NOTICE_LIMIT=20

work_dir="$(mktemp -d)"
pg_data="${work_dir}/postgres"
dump_file="${work_dir}/record.dump"

cleanup() {
  if [ -s "${pg_data}/postmaster.pid" ]; then
    gosu postgres pg_ctl -D "$pg_data" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM

milliseconds() {
  bun --eval 'process.stdout.write(String(Date.now()))'
}

failure() {
  echo "REHEARSAL FAIL $1"
  exit 1
}

migration_hash="$(bun scripts/record-migration-set.ts)" || failure 'could not hash the migration set'

if [ -n "${REHEARSAL_DUMP_FILE:-}" ] &&
  [ -z "${R2_BUCKET:-}${R2_ENDPOINT:-}${R2_ACCESS_KEY_ID:-}${R2_SECRET_ACCESS_KEY:-}" ]; then
  [ -f "$REHEARSAL_DUMP_FILE" ] || failure "local dump does not exist: $REHEARSAL_DUMP_FILE"
  cp "$REHEARSAL_DUMP_FILE" "$dump_file"
  newest_key="local/$(basename -- "$REHEARSAL_DUMP_FILE")"
else
  [ -n "${R2_BUCKET:-}" ] || failure 'R2_BUCKET is required'
  [ -n "${R2_ENDPOINT:-}" ] || failure 'R2_ENDPOINT is required'
  [ -n "${R2_ACCESS_KEY_ID:-}" ] || failure 'R2_ACCESS_KEY_ID is required'
  [ -n "${R2_SECRET_ACCESS_KEY:-}" ] || failure 'R2_SECRET_ACCESS_KEY is required'
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION=auto
  newest_key="$(aws --endpoint-url "$R2_ENDPOINT" s3api list-objects-v2 \
    --bucket "$R2_BUCKET" \
    --prefix record/ \
    --query 'sort_by(Contents, &LastModified)[-1].Key' \
    --output text)" || failure 'could not list record backups in R2'
  if [ -z "$newest_key" ] || [ "$newest_key" = None ]; then
    failure 'no dump exists under record/'
  fi
  aws --endpoint-url "$R2_ENDPOINT" s3 cp \
    "s3://${R2_BUCKET}/${newest_key}" "$dump_file" --only-show-errors ||
    failure "could not download dump $newest_key"
fi
echo "REHEARSAL DUMP $newest_key"

mkdir -p "$pg_data"
chown postgres:postgres "$work_dir" "$pg_data"
gosu postgres initdb -D "$pg_data" --auth-local=trust --auth-host=scram-sha-256 \
  >/dev/null 2>&1 || failure 'could not initialize local Postgres'
gosu postgres pg_ctl -D "$pg_data" -l "${work_dir}/postgres.log" \
  -o "-c listen_addresses=127.0.0.1" start >/dev/null || failure 'could not start local Postgres'

password="$(bun --eval 'process.stdout.write(crypto.randomUUID().replaceAll("-", ""))')"
psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 --quiet \
  --command 'CREATE ROLE record_owner NOLOGIN' \
  --command 'CREATE ROLE record_actor NOLOGIN' \
  --command 'CREATE ROLE record_auth NOLOGIN' \
  --command 'CREATE ROLE record_public NOLOGIN' \
  --command 'CREATE ROLE record_reader NOLOGIN' \
  --command 'GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE' \
  --command 'CREATE DATABASE record_rehearsal OWNER record_owner' >/dev/null ||
  failure 'could not create the local record roles and database'

restore_start="$(milliseconds)"
pg_restore --username postgres --dbname record_rehearsal --exit-on-error "$dump_file" \
  >/dev/null 2>"${work_dir}/restore-error" ||
  failure "restore failed: $(tr '\n' ' ' <"${work_dir}/restore-error")"
restore_ms="$(($(milliseconds) - restore_start))"

psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 --quiet \
  --command "ALTER ROLE record_owner LOGIN PASSWORD '${password}'" >/dev/null ||
  failure 'could not enable the local record owner login'
export BOTTEGA_RECORD_MIGRATE_URL="postgres://record_owner:${password}@127.0.0.1:5432/record_rehearsal"

pending_names="$(bun scripts/record-migration-set.ts --pending)" ||
  failure 'could not read pending record migrations from the restored drizzle journal'
if [ -n "$pending_names" ]; then
  pending_count="$(printf '%s\n' "$pending_names" | wc -l | tr -d ' ')"
else
  pending_count=0
fi
echo "REHEARSAL PENDING $pending_count"
echo "REHEARSAL RESTORE $restore_ms"

migrate_start="$(milliseconds)"
set +e
migrate_error="$(PENDING_MIGRATIONS="$pending_names" bun --eval '
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { migrationFailure } from "./orchestrator/src/postgres/migration-failure.ts";
  import { migratePostgres } from "./orchestrator/src/postgres/postgres-migrate.ts";
  const folder = join(process.cwd(), "shared", "record", "migrations");
  const pending = process.env.PENDING_MIGRATIONS?.split("\n").filter(Boolean) ?? [];
  try {
    await migratePostgres();
  } catch (error) {
    console.error(migrationFailure(error, pending, (name) =>
      readFileSync(join(folder, name, "migration.sql"), "utf8")
    ));
    process.exit(1);
  }
' 2>&1)"
migrate_exit=$?
set -e
migrate_ms="$(($(milliseconds) - migrate_start))"
echo "REHEARSAL MIGRATE $migrate_ms"
if [ "$migrate_exit" -ne 0 ]; then
  failure "$migrate_error"
fi
printf '%s\n' "$migrate_error" | awk -v limit="$REHEARSAL_NOTICE_LIMIT" '
  /^MIGRATE NOTICE / {
    count += 1
    if (count <= limit) print "REHEARSAL NOTICE " $0
  }
  END {
    if (count > limit) print "REHEARSAL NOTICE-TRUNCATED " count - limit
  }
'

echo "REHEARSAL PASS $migration_hash"
