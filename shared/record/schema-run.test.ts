import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationSessionStatements } from './migration-session.ts'
import { RECORD_OWNER_ROLE } from './schema.ts'

const migrationsFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
const guardMigration = '20261102141436_dev_2040_run_task_or_project_guard'
const constraintMigration = '20261102141447_dev_2040_run_task_or_project_constraint'
const firstSpaceId = '01990000-0000-7000-8000-000000002040'
const secondSpaceId = '01990000-0000-7000-8000-000000002041'
const userId = '01990000-0000-7000-8000-000000002042'
const machineId = '01990000-0000-7000-8000-000000002043'

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

async function prepareDatabase(database: PGlite) {
  await database.exec(`
    CREATE ROLE record_owner LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_actor LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_auth LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_reader LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;
    GRANT CREATE ON DATABASE postgres TO record_owner;
    ALTER SCHEMA public OWNER TO record_owner;
    SET ROLE record_owner;
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text
    );
  `)
}

function runInsert(id: string, spaceId: string, probe: boolean): string {
  return `
    INSERT INTO run (
      id,evidence_seq,space_id,machine_id,started_by_user_id,started_at,agent,job,
      prompt_sha,prompt_bytes,prompt_head,probe,status,turn,no_failover,
      automatic_failover,work_preserved,created_at,updated_at
    ) VALUES (
      '${id}',1,'${spaceId}','${machineId}','${userId}',now(),'test-agent','writing',
      'prompt-sha',1,'prompt',${probe},'done',1,false,false,true,now(),now()
    );
  `
}

test('run link guard sees every space and the constraint permits only unlinked probes', async () => {
  const database = new PGlite()
  try {
    await prepareDatabase(database)
    const migrations = readMigrationFiles({ migrationsFolder })
    const guard = migrations.find((migration) => migration.name === guardMigration)
    const constraint = migrations.find((migration) => migration.name === constraintMigration)
    if (!guard || !constraint) throw new Error('missing DEV-2040 record migrations')

    await database.transaction(async (transaction) => {
      for (const statement of migrationSessionStatements()) await transaction.exec(statement)
      for (const migration of migrations) {
        if (migration.name === guardMigration || migration.name === constraintMigration) continue
        await applyMigration(transaction, migration)
      }
    })
    await database.exec(`
      RESET ROLE;
      INSERT INTO space (id,name,slug,created_at) VALUES
        ('${firstSpaceId}','Run constraint one','run-constraint-one',now()),
        ('${secondSpaceId}','Run constraint two','run-constraint-two',now());
      INSERT INTO "user" (id,email,name,created_at)
      VALUES ('${userId}','run-constraint@example.test','Run constraint',now());
      INSERT INTO machine (id,user_id,name,registered_at,last_seen)
      VALUES ('${machineId}','${userId}','run-constraint',now(),now());
      ${runInsert('01990000-0000-7000-8000-000000002044', firstSpaceId, false)}
      ${runInsert('01990000-0000-7000-8000-000000002045', secondSpaceId, false)}
      SET ROLE ${RECORD_OWNER_ROLE};
    `)
    expect(
      (
        await database.query<{ relforcerowsecurity: boolean }>(
          `SELECT relforcerowsecurity FROM pg_class WHERE oid='run'::regclass`,
        )
      ).rows[0]?.relforcerowsecurity,
    ).toBeTrue()
    const guardFailure = database.transaction(async (transaction) =>
      applyMigration(transaction, guard),
    )
    await expect(guardFailure).rejects.toThrow(
      'run_task_or_project_unless_probe blocked by 2 violating rows',
    )
    await expect(guardFailure).rejects.toThrow('01990000-0000-7000-8000-000000002044')

    await database.exec(`
      RESET ROLE;
      DELETE FROM run;
      SET ROLE ${RECORD_OWNER_ROLE};
    `)
    await database.transaction(async (transaction) => {
      await applyMigration(transaction, guard)
      await applyMigration(transaction, constraint)
    })
    await database.exec('RESET ROLE')

    await expect(
      database.exec(runInsert('01990000-0000-7000-8000-000000002046', firstSpaceId, false)),
    ).rejects.toThrow('run_task_or_project_unless_probe')
    await database.exec(runInsert('01990000-0000-7000-8000-000000002047', firstSpaceId, true))
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM run WHERE id='01990000-0000-7000-8000-000000002047'`,
        )
      ).rows[0]?.count,
    ).toBe(1)
  } finally {
    await database.close()
  }
})
