import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const url = process.env.ORCH_TEST_WORKFLOW_GENERATION_MIGRATION_URL
const postgres = url ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const generationMigration = '20261019210000_dev_1406_workflow_generation_replay'
let priorMigrations = ''
let priorHistoryCounts:
  | {
      workflow_versions: number
      workflow_events: number
      catalogue_versions: number
      catalogue_events: number
    }
  | undefined

const SPACE_ID = '01990000-0000-7000-8000-000000014060'
const WORKFLOW_ID = '01990000-0000-7000-8000-000000014061'
const WORKFLOW_VERSION_ID = '01990000-0000-7000-8000-000000014062'
const CATALOGUE_ID = '01990000-0000-7000-8000-000000014063'
const CATALOGUE_VERSION_ID = '01990000-0000-7000-8000-000000014064'

postgres('populated workflow generation replay migration', () => {
  beforeAll(async () => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-1406-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < generationMigration))
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })

    const sql = new SQL(url!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await sql.unsafe(`
        ALTER TABLE workflow NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE workflow_version NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE workflow_event NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue_version NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue_event NO FORCE ROW LEVEL SECURITY;
      `)
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${SPACE_ID}::uuid,'generation replay','generation-replay',now())`
      await sql`INSERT INTO workflow (id,space_id,slug,generation,created_at,updated_at) VALUES (${WORKFLOW_ID}::uuid,${SPACE_ID}::uuid,'flow',1,now(),now())`
      await sql`INSERT INTO workflow_version (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at) VALUES (${WORKFLOW_VERSION_ID}::uuid,${SPACE_ID}::uuid,${WORKFLOW_ID}::uuid,1,'production','{}','test','test',now(),now())`
      await sql`INSERT INTO workflow_event (id,space_id,workflow_version_id,event,author,reason,at,updated_at) VALUES ('01990000-0000-7000-8000-000000014065'::uuid,${SPACE_ID}::uuid,${WORKFLOW_VERSION_ID}::uuid,'promote','test','test',now(),now())`
      await sql`INSERT INTO step_catalogue (id,space_id,slug,generation,created_at,updated_at) VALUES (${CATALOGUE_ID}::uuid,${SPACE_ID}::uuid,'shared',1,now(),now())`
      await sql`INSERT INTO step_catalogue_version (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at) VALUES (${CATALOGUE_VERSION_ID}::uuid,${SPACE_ID}::uuid,${CATALOGUE_ID}::uuid,1,'production','{}','test','test',now(),now())`
      await sql`INSERT INTO step_catalogue_event (id,space_id,catalogue_version_id,event,author,reason,at,updated_at) VALUES ('01990000-0000-7000-8000-000000014066'::uuid,${SPACE_ID}::uuid,${CATALOGUE_VERSION_ID}::uuid,'promote','test','test',now(),now())`
      ;[priorHistoryCounts] = await sql`SELECT
        (SELECT count(*) FROM workflow_version WHERE workflow_id=${WORKFLOW_ID}::uuid)::integer workflow_versions,
        (SELECT count(*) FROM workflow_event WHERE workflow_version_id=${WORKFLOW_VERSION_ID}::uuid)::integer workflow_events,
        (SELECT count(*) FROM step_catalogue_version WHERE catalogue_id=${CATALOGUE_ID}::uuid)::integer catalogue_versions,
        (SELECT count(*) FROM step_catalogue_event WHERE catalogue_version_id=${CATALOGUE_VERSION_ID}::uuid)::integer catalogue_events`
      await sql.unsafe(`
        ALTER TABLE workflow FORCE ROW LEVEL SECURITY;
        ALTER TABLE workflow_version FORCE ROW LEVEL SECURITY;
        ALTER TABLE workflow_event FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue_version FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue_event FORCE ROW LEVEL SECURITY;
      `)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('bumps identities without changing version or event row counts', async () => {
    const sql = new SQL(url!)
    try {
      await sql.unsafe(`
        ALTER TABLE workflow NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE workflow_version NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE workflow_event NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue_version NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE step_catalogue_event NO FORCE ROW LEVEL SECURITY;
      `)
      const [row] = await sql`SELECT
        (SELECT generation FROM workflow WHERE id=${WORKFLOW_ID}::uuid)::integer workflow_generation,
        (SELECT count(*) FROM workflow_version WHERE workflow_id=${WORKFLOW_ID}::uuid)::integer workflow_versions,
        (SELECT count(*) FROM workflow_event WHERE workflow_version_id=${WORKFLOW_VERSION_ID}::uuid)::integer workflow_events,
        (SELECT generation FROM step_catalogue WHERE id=${CATALOGUE_ID}::uuid)::integer catalogue_generation,
        (SELECT count(*) FROM step_catalogue_version WHERE catalogue_id=${CATALOGUE_ID}::uuid)::integer catalogue_versions,
        (SELECT count(*) FROM step_catalogue_event WHERE catalogue_version_id=${CATALOGUE_VERSION_ID}::uuid)::integer catalogue_events`
      expect(row).toMatchObject({ workflow_generation: 2, catalogue_generation: 2 })
      expect({
        workflow_versions: row?.workflow_versions,
        workflow_events: row?.workflow_events,
        catalogue_versions: row?.catalogue_versions,
        catalogue_events: row?.catalogue_events,
      }).toEqual(priorHistoryCounts!)
    } finally {
      await sql.close()
    }
  })
})
