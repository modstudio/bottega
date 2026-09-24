# Record backup deployment

This job writes a nightly custom-format PostgreSQL dump to a private Cloudflare R2 bucket and removes objects older than 30 days. Fly volume snapshots remain a separate recovery layer.

Run commands from the repository root. Create the private bucket and scoped R2 credentials in the `modstud.io` account, then create the app without launching a service:

```sh
fly apps create bottega-record-backup --org bottega
fly secrets set -a bottega-record-backup \
  RECORD_BACKUP_DATABASE_URL='postgres://record_backup:<password>@bottega-record.flycast:5432/record' \
  R2_BUCKET='<private-bucket>' \
  R2_ENDPOINT='https://<account-id>.r2.cloudflarestorage.com' \
  R2_ACCESS_KEY_ID='<access-key-id>' \
  R2_SECRET_ACCESS_KEY='<secret-access-key>' \
  BACKUP_RETENTION_DAYS='30'
```

`RECORD_BACKUP_DATABASE_URL` uses the dedicated `record_backup` role. Record tables use `FORCE ROW LEVEL SECURITY`, which confines even their owner, so `pg_dump` as `record_owner` refuses with "query would be affected by row-level security policy". The backup role must bypass row security and read every schema. As the cluster administrator:

```sql
CREATE ROLE record_backup LOGIN BYPASSRLS PASSWORD '<generated>';
GRANT pg_read_all_data TO record_backup;
GRANT CONNECT ON DATABASE record TO record_backup;
```

Keep all values above as Fly secrets; do not put them in this tree or shell history.

## Schedule and manual run

Fly scheduled Machines are approximate-interval jobs, not wall-clock cron. Build and create the daily Machine with:

```sh
fly machine run . \
  --app bottega-record-backup \
  --config orchestrator/deploy/backup/fly.toml \
  --dockerfile orchestrator/deploy/backup/Dockerfile \
  --region ewr \
  --vm-size shared-cpu-1x \
  --schedule daily
```

Run the same image once by hand with an automatically removed Machine:

```sh
fly machine run . \
  --app bottega-record-backup \
  --config orchestrator/deploy/backup/fly.toml \
  --dockerfile orchestrator/deploy/backup/Dockerfile \
  --region ewr \
  --vm-size shared-cpu-1x \
  --rm
```

Check `fly machine list -a bottega-record-backup` and the Machine logs after creation and after the first scheduled run. A successful run prints the uploaded object name and verified byte count without printing credentials.

## Restore drill

Never make the hosted database the first restore target. With an existing dump, restore it into an ephemeral PostgreSQL 18 container and print the required row counts:

```sh
orchestrator/deploy/backup/restore-check.sh ./record-20260917T020000Z.dump
```

With no file argument, the script builds the backup image, downloads the newest `record/` object, and performs the same check. Export the four `R2_*` values in the invoking shell first:

```sh
orchestrator/deploy/backup/restore-check.sh
```

The check creates the `record_owner`, `record_actor`, `record_auth`, and `record_reader` roles before restoring. It verifies table and constraint inventory, prints row counts for `run`, `run_score`, `doc`, `doc_revision`, and `project`, and always removes the container.

## Restore the hosted record

1. Stop every writer, including the record API and direct CLI syncs. Preserve the current database and role credentials until the replacement has been validated.
2. Restore into a new scratch database first with `restore-check.sh`. Compare the printed row counts with the source or the last known healthy report.
3. As the PostgreSQL cluster administrator, ensure the login roles `record_owner`, `record_actor`, `record_auth`, and `record_reader` exist. Create an empty replacement database owned by `record_owner`; then run `ALTER SCHEMA public OWNER TO record_owner` in it. The owner connection belongs in `ORCH_RECORD_MIGRATE_URL`; application traffic must continue to use `record_actor` through `ORCH_RECORD_URL`.
4. Restore the archive with the PostgreSQL 18 client and fail on the first error:

   ```sh
   pg_restore --exit-on-error --dbname '<replacement-owner-url>' ./record-<UTC timestamp>.dump
   ```

   Run `pg_restore` as a role that bypasses row security (the cluster administrator), because `FORCE ROW LEVEL SECURITY` refuses row loads from any other role. Do not use `--no-owner` for the real restore. Archive ownership and grants depend on the four roles already existing. Confirm that `public` and restored application objects are owned by `record_owner`, and that the `drizzle` migration schema and journal were restored.

5. Run SQL checks for table count, constraint count, and the five row counts used by `restore-check.sh`. Also test an actor connection and a reader connection so grants and row-level security behavior are not inferred from a successful `pg_restore` exit alone.
6. Point the API and migration secrets at the replacement database, start the writers, and verify API health plus a read. Keep the previous database intact until those checks pass. If the database must retain the name `record`, perform the final rename or drop/recreate only during the maintenance window, with all connections terminated and a rollback copy available.

The role and schema ownership requirements above come from `.agents/contexts/orchestrator-runs.md`; a restore that omits them can load data while leaving migration, application, or reporting access broken.
