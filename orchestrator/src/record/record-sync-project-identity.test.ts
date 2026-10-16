import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { backfillReleaseRecords } from '../release/release-outbox.ts'
import { syncRecord } from './record-sync.ts'

const PROJECT_ID = '01990000-0000-7000-8000-000000000088'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const MACHINE_ID = '01990000-0000-7000-8000-000000000002'

function oldShapeRun(projectId: number | null): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, synced_at TEXT, quarantined_at TEXT, quarantine_reason TEXT,
    retired_at TEXT, retirement_reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL);
  CREATE TABLE project (id INTEGER PRIMARY KEY, record_id TEXT, name TEXT, settings TEXT);
  CREATE TABLE run (record_id TEXT PRIMARY KEY, project_id INTEGER)`)
  if (projectId) local.query('INSERT INTO project VALUES (1,?,?,?)').run(PROJECT_ID, 'widget', '{}')
  local.query('INSERT INTO run VALUES (?,?)').run('run-record', projectId)
  local
    .query(
      "INSERT INTO outbox VALUES (1,'run','outbox-record','run-record',?,'2026-09-15',0,NULL,NULL,NULL,NULL,NULL,NULL)",
    )
    .run(
      JSON.stringify({
        id: 'run-record',
        projectId: null,
        projectName: 'widget',
        machineId: MACHINE_ID,
      }),
    )
  return local
}

function backfilledUnscopedRelease(): Database {
  const local = new Database(':memory:')
  applyMigrations(local)
  local
    .query(
      `INSERT INTO release_ledger
       (record_id,project,project_id,rung,candidate_commit,rollback,actor,started_at)
       VALUES ('01990000-0000-7000-8000-000000000077','widget',NULL,'production','sha',0,
               'operator','2026-09-15T00:00:00.000Z')`,
    )
    .run()
  expect(backfillReleaseRecords(local)).toEqual({ enqueued: 1 })
  return local
}

function oldShapeRelease(): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, synced_at TEXT, quarantined_at TEXT, quarantine_reason TEXT,
    retired_at TEXT, retirement_reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL);
  CREATE TABLE project (id INTEGER PRIMARY KEY, record_id TEXT, name TEXT, settings TEXT);
  CREATE TABLE release_ledger (record_id TEXT PRIMARY KEY, project_id INTEGER)`)
  local.query('INSERT INTO project VALUES (1,?,?,?)').run(PROJECT_ID, 'widget', '{}')
  local.query('INSERT INTO release_ledger VALUES (?,1)').run('release-record')
  local
    .query(
      "INSERT INTO outbox VALUES (1,'release','outbox-record','release-record',?,'2026-09-15',0,NULL,NULL,NULL,NULL,NULL,NULL)",
    )
    .run(JSON.stringify({ id: 'release-record', projectName: 'widget', machineId: MACHINE_ID }))
  return local
}

async function syncPayload(local: Database): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {}
  const result = await syncRecord({
    local,
    now: () => '2026-09-15T01:01:00.000Z',
    identity: { id: MACHINE_ID, name: 'test-machine' },
    client: {
      whoami: async () => ({
        user: { id: MACHINE_ID },
        activeSpaceId: SPACE_ID,
        personalSpaceId: SPACE_ID,
        memberships: [{ space_id: SPACE_ID, slug: 'platform', permission: 'write' }],
      }),
      sync: async (request) => {
        sent = JSON.parse(request.rows[0]!.payload) as Record<string, unknown>
        return { results: [{ id: request.rows[0]!.id, status: 'synced' as const }] }
      },
    },
  })
  expect(result).toMatchObject({ pushed: 1, failed: 0, quarantined: [] })
  local.close()
  return sent
}

async function sentPayload(projectId: number | null): Promise<Record<string, unknown>> {
  return syncPayload(oldShapeRun(projectId))
}

test('an old-shape run derives its project UUID from its source row', async () => {
  expect(await sentPayload(1)).toMatchObject({ projectId: PROJECT_ID, projectName: 'widget' })
})

test('a run with a null project id whose source has no project is sent unscoped', async () => {
  expect(await sentPayload(null)).toMatchObject({ projectId: null, projectName: null })
})

test('a backfilled release whose source has no project is sent unscoped', async () => {
  expect(await syncPayload(backfilledUnscopedRelease())).toMatchObject({
    projectId: null,
    projectName: null,
  })
})

test('an old-shape release derives its project UUID from its source row', async () => {
  expect(await syncPayload(oldShapeRelease())).toMatchObject({
    projectId: PROJECT_ID,
    projectName: 'widget',
  })
})
