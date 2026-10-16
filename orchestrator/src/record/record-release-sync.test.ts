import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineId } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { applyMigrations } from '../database/migrations.ts'
import { finishReleaseLedgerEntry, startReleaseLedgerEntry } from '../release/release-ledger.ts'
import { syncRecord } from './record-sync.ts'
import { syncHostedRecord } from './record-sync-service.ts'

const MACHINE_ID = machineId()
const SPACE_ID = '01990000-0000-7000-8000-000000000001'

type LocalOutboxRow = { record_id: string; payload: string; created_at: string }

function senderStore(row: LocalOutboxRow): Database {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  ); CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL);
  CREATE TABLE project (name TEXT PRIMARY KEY, record_id TEXT NOT NULL, settings TEXT NOT NULL);`)
  database
    .query("INSERT INTO project VALUES (?,'01990000-0000-7000-8000-000000000088','{}')")
    .run(PLATFORM_SLUG)
  database
    .query(
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'release',?,?,?)",
    )
    .run(newRecordId(), row.record_id, row.payload, row.created_at)
  return database
}

test('release sender upserts the finished state by record id in the project space', async () => {
  const source = new Database(':memory:')
  applyMigrations(source)
  source
    .query(
      `INSERT INTO project(record_id,name,path,canon,settings) VALUES (? ,?,'/tmp/${PLATFORM_SLUG}',1,'{}')`,
    )
    .run('01990000-0000-7000-8000-000000000088', PLATFORM_SLUG)
  const releaseId = startReleaseLedgerEntry(source, {
    project: PLATFORM_SLUG,
    rung: 'production',
    candidate: 'candidate-sha',
    live: 'before-sha',
    rollback: false,
    reason: null,
  })
  const started = source
    .query<LocalOutboxRow, []>('SELECT row_id AS record_id,payload,created_at FROM outbox')
    .get()!
  const local = senderStore(started)
  const remote = fakePostgres()
  const options = {
    local,
    now: () => '2026-10-12T00:05:00.000Z',
    identity: { id: MACHINE_ID, name: 'test-machine' },
    principal: {
      userId: '01990000-0000-7000-8000-000000000002',
      spaceId: SPACE_ID,
    },
    memberships: [{ spaceId: SPACE_ID, slug: 'platform', permission: 'write' as const }],
    client: {
      whoami: async () => ({
        user: { id: '01990000-0000-7000-8000-000000000002' },
        activeSpaceId: SPACE_ID,
        personalSpaceId: SPACE_ID,
        memberships: [{ space_id: SPACE_ID, slug: 'platform', permission: 'write' }],
      }),
      sync: (request: Parameters<typeof syncHostedRecord>[0]['request']) =>
        syncHostedRecord({
          url: 'postgres://record.test/database',
          identity: {
            user: { id: '01990000-0000-7000-8000-000000000002' },
            activeSpaceId: SPACE_ID,
            personalSpaceId: SPACE_ID,
            memberships: [{ space_id: SPACE_ID, slug: 'platform', permission: 'write' }],
          },
          request,
          postgres: remote.sql,
        }),
    },
  }

  expect(await syncRecord(options)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
  source.query("UPDATE outbox SET synced_at='2026-10-12T00:05:00.000Z'").run()
  finishReleaseLedgerEntry(
    source,
    releaseId,
    { exitCode: 0, output: '' },
    'local deploy output',
    'candidate-sha',
    true,
    null,
  )
  const finished = source
    .query<LocalOutboxRow, []>(
      'SELECT row_id AS record_id,payload,created_at FROM outbox WHERE synced_at IS NULL',
    )
    .get()!
  local
    .query(
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'release',?,?,?)",
    )
    .run(newRecordId(), finished.record_id, finished.payload, finished.created_at)
  expect(await syncRecord(options)).toMatchObject({ pushed: 1, failed: 0, pending: 0 })

  const writes = remote.statements.filter((statement) =>
    statement.toLowerCase().includes('insert into "release"'),
  )
  expect(writes).toHaveLength(2)
  for (const statement of writes) {
    expect(statement).toMatch(/on conflict \("id"\) do update set/i)
    const [, columns, values] = statement.match(/insert into [^(]+\(([^)]+)\) values \(([^)]+)\)/i)!
    const localIdIndex = columns!.split(', ').indexOf('"local_id"')
    expect(values!.split(', ')[localIdIndex]).toBe('default')
    expect(statement.slice(statement.indexOf('do update set'))).not.toMatch(/local_id/i)
  }
  expect(remote.parameters.flat().filter((value) => value === started.record_id)).toHaveLength(2)
  expect(remote.parameters.flat()).toContain('candidate-sha')
  expect(remote.parameters.flat()).not.toContain('local deploy output')
  expect(remote.transactionSpaceIds).toContain(SPACE_ID)
  source.close()
  local.close()
})
