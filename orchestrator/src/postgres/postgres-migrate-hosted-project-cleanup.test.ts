import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const successUrl = process.env.BOTTEGA_TEST_HOSTED_PROJECT_CLEANUP_URL
const collisionUrl = process.env.BOTTEGA_TEST_HOSTED_PROJECT_CLEANUP_COLLISION_URL
const realPostgres = successUrl && collisionUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const cleanupMigration = '20261019214243_dev_1214_hosted_project_cleanup'
const cleanupSql = readFileSync(join(migrationsFolder, cleanupMigration, 'migration.sql'), 'utf8')
let priorMigrations = ''

const destinationSpace = '01990000-0000-7000-8000-000000001400'
const localProject = '01990000-0000-7000-8000-000000001401'
const movedProject = '01990000-0000-7000-8000-000000001402'
const localDoc = '01990000-0000-7000-8000-000000001403'
const localRevision = '01990000-0000-7000-8000-000000001404'
const resumeDoc = '01990000-0000-7000-8000-000000001405'
const resumeRevision = '01990000-0000-7000-8000-000000001406'
const canonDoc = '01990000-0000-7000-8000-000000001407'
const hubTask = '01990000-0000-7000-8000-000000001408'
const collisionDoc = '01990000-0000-7000-8000-000000001409'

async function seed(sql: SQL, collision: boolean): Promise<void> {
  await sql.unsafe(`
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${destinationSpace}','Cleanup destination','cleanup-destination',now());
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    INSERT INTO project (id,space_id,name,created_at) VALUES
      ('${localProject}','${PLATFORM_SPACE_ID}','cleanup-local',now()),
      ('${movedProject}','${destinationSpace}','cleanup-moved',now());
    INSERT INTO doc
      (id,space_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at)
    VALUES
      ('${localDoc}','${PLATFORM_SPACE_ID}','project','cleanup-local','local','Local','body','demand',ARRAY['technical'],now(),now()),
      ('${resumeDoc}','${PLATFORM_SPACE_ID}','resume','cleanup-moved','brief','Brief','body','demand',ARRAY['technical'],now(),now()),
      ('${canonDoc}','${PLATFORM_SPACE_ID}','canon',NULL,'AGENTS.md','Canon','body','inject',ARRAY['technical'],now(),now())
      ${collision ? `,('${collisionDoc}','${destinationSpace}','resume','cleanup-moved','brief','Collision','body','demand',ARRAY['technical'],now(),now())` : ''};
    INSERT INTO doc_revision
      (id,space_id,doc_id,scope,subject,slug,op,title,body,delivery,audiences,author,reason,at)
    VALUES
      ('${localRevision}','${PLATFORM_SPACE_ID}','${localDoc}','project','cleanup-local','local','create','Local','body','demand',ARRAY['technical'],'proof','proof backfill',now()),
      ('${resumeRevision}','${PLATFORM_SPACE_ID}','${resumeDoc}','resume','cleanup-moved','brief','create','Brief','body','demand',ARRAY['technical'],'proof','proof move',now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${hubTask}','${PLATFORM_SPACE_ID}','cleanup-local','CLEANUP-1','cleanup-local','local',now(),now(),now(),now());
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
  `)
}

async function facts(sql: SQL): Promise<unknown[]> {
  await sql.unsafe(`
    ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
  `)
  const rows = await sql.unsafe(`
    SELECT 'canon' AS kind, space_id::text, project_id::text FROM doc WHERE id='${canonDoc}'
    UNION ALL SELECT 'hub', space_id::text, project_id::text FROM hub_task WHERE id='${hubTask}'
    UNION ALL SELECT 'local-doc', space_id::text, project_id::text FROM doc WHERE id='${localDoc}'
    UNION ALL SELECT 'local-revision', space_id::text, project_id::text FROM doc_revision WHERE id='${localRevision}'
    UNION ALL SELECT 'resume-doc', space_id::text, project_id::text FROM doc WHERE id='${resumeDoc}'
    UNION ALL SELECT 'resume-revision', space_id::text, project_id::text FROM doc_revision WHERE id='${resumeRevision}'
    ORDER BY kind
  `)
  await sql.unsafe(`
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
  `)
  return rows
}

async function migrationRefusal(sql: SQL) {
  for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
  const failure = await migrate(drizzle({ client: sql }), { migrationsFolder }).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  return ((failure as Error).cause as Error | undefined)?.message ?? ''
}

realPostgres('populated hosted project cleanup', () => {
  beforeAll(() => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-1214-hosted-cleanup-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < cleanupMigration))
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('backfills, moves, preserves space documents, and reruns as a no-op', async () => {
    const sql = new SQL(successUrl!)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seed(sql, false)
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      const expected = [
        { kind: 'canon', space_id: PLATFORM_SPACE_ID, project_id: null },
        { kind: 'hub', space_id: PLATFORM_SPACE_ID, project_id: localProject },
        { kind: 'local-doc', space_id: PLATFORM_SPACE_ID, project_id: localProject },
        { kind: 'local-revision', space_id: PLATFORM_SPACE_ID, project_id: localProject },
        { kind: 'resume-doc', space_id: destinationSpace, project_id: movedProject },
        { kind: 'resume-revision', space_id: destinationSpace, project_id: movedProject },
      ]
      expect(await facts(sql)).toEqual(expected)
      await sql.begin(async (tx) => tx.unsafe(cleanupSql))
      expect(await facts(sql)).toEqual(expected)
    } finally {
      await sql.close()
    }
  })

  test('an address collision refuses the transaction without a partial backfill', async () => {
    const sql = new SQL(collisionUrl!)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await seed(sql, true)
      expect(await migrationRefusal(sql)).toContain('destination addresses already exist')
      const unchanged = await facts(sql)
      expect(unchanged).toContainEqual({
        kind: 'local-doc',
        space_id: PLATFORM_SPACE_ID,
        project_id: null,
      })
      expect(unchanged).toContainEqual({
        kind: 'resume-doc',
        space_id: PLATFORM_SPACE_ID,
        project_id: null,
      })
    } finally {
      await sql.close()
    }
  })
})
