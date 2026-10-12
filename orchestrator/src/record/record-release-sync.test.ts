import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { applyMigrations } from '../database/migrations.ts'
import { finishEntry, insertStarted } from '../release/release-service.ts'
import { syncRecord } from './record-sync.ts'

const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'

type LocalOutboxRow = { record_id: string; payload: string; created_at: string }

function senderStore(row: LocalOutboxRow): Database {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  ); CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL);
  CREATE TABLE project (name TEXT PRIMARY KEY, settings TEXT NOT NULL);`)
  database.query("INSERT INTO project VALUES (?,'{}')").run(PLATFORM_SLUG)
  database
    .query("INSERT INTO outbox (kind,record_id,payload,created_at) VALUES ('release',?,?,?)")
    .run(row.record_id, row.payload, row.created_at)
  return database
}

test('release sender upserts the finished state by record id in the project space', async () => {
  const source = new Database(':memory:')
  applyMigrations(source)
  source
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  const releaseId = insertStarted(
    {
      project: PLATFORM_SLUG,
      rung: 'production',
      candidate: 'candidate-sha',
      live: 'before-sha',
      rollback: false,
      reason: null,
    },
    source,
  )
  const started = source
    .query<LocalOutboxRow, []>('SELECT record_id,payload,created_at FROM outbox')
    .get()!
  const local = senderStore(started)
  const remote = fakePostgres()
  const options = {
    recordUrl: 'postgres://record.test/database',
    local,
    openSql: () => remote.sql,
    now: () => '2026-10-12T00:05:00.000Z',
    identity: { id: MACHINE_ID, name: 'test-machine' },
    principal: {
      userId: '01990000-0000-7000-8000-000000000002',
      spaceId: SPACE_ID,
    },
    memberships: [{ spaceId: SPACE_ID, slug: 'platform', permission: 'write' as const }],
  }

  expect(await syncRecord(options)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  source.query("UPDATE outbox SET synced_at='2026-10-12T00:05:00.000Z'").run()
  finishEntry(
    releaseId,
    { exitCode: 0, output: '' },
    'local deploy output',
    'candidate-sha',
    true,
    null,
    source,
  )
  const finished = source
    .query<LocalOutboxRow, []>(
      'SELECT record_id,payload,created_at FROM outbox WHERE synced_at IS NULL',
    )
    .get()!
  local
    .query("INSERT INTO outbox (kind,record_id,payload,created_at) VALUES ('release',?,?,?)")
    .run(finished.record_id, finished.payload, finished.created_at)
  expect(await syncRecord(options)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })

  const writes = remote.statements.filter((statement) =>
    statement.toLowerCase().includes('insert into "release"'),
  )
  expect(writes).toHaveLength(2)
  expect(remote.parameters.flat().filter((value) => value === started.record_id)).toHaveLength(2)
  expect(remote.parameters.flat()).toContain('candidate-sha')
  expect(remote.parameters.flat()).not.toContain('local deploy output')
  expect(remote.transactionSpaceIds).toContain(SPACE_ID)
  source.close()
  local.close()
})
