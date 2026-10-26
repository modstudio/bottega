import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'

export const HOSTED_FIXTURE_MACHINE_ID = '01990000-0000-7000-8000-000000001249'

const migrationsFolder = join(
  fileURLToPath(new URL('../../shared/record/migrations', import.meta.url)),
)

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

export async function createHostedRecordFixture(options: {
  spaceId: string
  userId: string
}): Promise<PGlite> {
  const database = new PGlite()
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
  await database.transaction(async (transaction) => {
    for (const migration of readMigrationFiles({ migrationsFolder }))
      await applyMigration(transaction, migration)
  })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${options.spaceId}','Mirror test','mirror-test',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${options.userId}','mirror@example.test','Mirror user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000001248','${options.spaceId}','${options.userId}','member','write',now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${HOSTED_FIXTURE_MACHINE_ID}','${options.userId}','fixture',now(),now());
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${options.userId}',false);
    SELECT set_config('app.space_id','${options.spaceId}',false);
    SELECT set_config('app.space_ids','${options.spaceId}',false);
  `)
  return database
}

type SqlFragment = { readonly sql: string }

function pgliteQuery(database: Pick<PGlite, 'query'>): SQL {
  const query = async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
    let statement = strings[0]!
    const parameters: unknown[] = []
    for (const [index, interpolation] of interpolations.entries()) {
      if (typeof interpolation === 'object' && interpolation !== null && 'sql' in interpolation) {
        statement += (interpolation as SqlFragment).sql
      } else {
        parameters.push(interpolation)
        statement += `$${parameters.length}`
      }
      statement += strings[index + 1]!
    }
    return (await database.query(statement, parameters)).rows
  }
  query.unsafe = (sql: string) => ({ sql })
  return query as unknown as SQL
}

export function pgliteSql(database: PGlite): SQL {
  const query = pgliteQuery(database)
  const begin = <T>(work: (tx: SQL) => Promise<T>) =>
    database.transaction((transaction) => work(pgliteQuery(transaction)))
  query.begin = begin as SQL['begin']
  return query
}
