import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { RecordApiRequestError } from './record-api-client.ts'
import { syncRecord } from './record-sync.ts'
import { RECORD_SYNC_BATCH_SIZE } from './record-sync-contract.ts'

const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const USER_ID = '01990000-0000-7000-8000-000000000002'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const STAMP = '2026-09-15T01:01:00.000Z'

function localOutbox(count: number): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  for (let id = 1; id <= count; id++) {
    local
      .query(
        "INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),?,'run',?,?,?)",
      )
      .run(id, `record-${id}`, '{}', STAMP)
  }
  return local
}

const whoami = async () => ({
  user: { id: USER_ID },
  activeSpaceId: SPACE_ID,
  personalSpaceId: SPACE_ID,
  memberships: [{ space_id: SPACE_ID, slug: 'platform', permission: 'write' }],
})

const options = (local: Database) => ({
  local,
  now: () => STAMP,
  identity: { id: MACHINE_ID, name: 'test-machine' },
})

test('sync sends an empty batch to register and refresh its machine', async () => {
  using local = localOutbox(0)
  const requests: unknown[] = []
  const client = {
    whoami,
    sync: async (request: unknown) => {
      requests.push(request)
      return { results: [] }
    },
  }

  expect(await syncRecord({ ...options(local), client })).toMatchObject({ pushed: 0, pending: 0 })
  expect(requests).toEqual([
    {
      machine: { id: MACHINE_ID, name: 'test-machine', seenAt: STAMP },
      rows: [],
    },
  ])
})

test('sync sends ordered bounded batches and applies each response before continuing', async () => {
  using local = localOutbox(RECORD_SYNC_BATCH_SIZE + 1)
  const batches: number[][] = []
  const client = {
    whoami,
    sync: async (request: { rows: { id: number }[] }) => {
      batches.push(request.rows.map((row) => row.id))
      return { results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })) }
    },
  }
  expect(await syncRecord({ ...options(local), client })).toMatchObject({
    pushed: RECORD_SYNC_BATCH_SIZE + 1,
    pending: 0,
  })
  expect(batches.map((batch) => batch.length)).toEqual([RECORD_SYNC_BATCH_SIZE, 1])
  expect(batches.flat()).toEqual(
    Array.from({ length: RECORD_SYNC_BATCH_SIZE + 1 }, (_, index) => index + 1),
  )
})

test('a malformed ordered response marks no local row', async () => {
  using local = localOutbox(2)
  const client = {
    whoami,
    sync: async () => ({
      results: [
        { id: 1, status: 'synced' as const },
        { id: 999, status: 'synced' as const },
      ],
    }),
  }
  await expect(syncRecord({ ...options(local), client })).rejects.toThrow(
    'record sync response order did not match the request',
  )
  expect(
    local.query('SELECT attempts,synced_at,quarantined_at FROM outbox ORDER BY id').all(),
  ).toEqual([
    { attempts: 0, synced_at: null, quarantined_at: null },
    { attempts: 0, synced_at: null, quarantined_at: null },
  ])
})

test('malformed refusal fields mark no local row', async () => {
  for (const result of [
    { id: 1, status: 'quarantined' as const },
    { id: 1, status: 'quarantined' as const, reason: '' },
    { id: 1, status: 'deferred' as const, reason: 'read-only' },
    { id: 1, status: 'deferred' as const, reason: '', spaceId: 'space' },
    { id: 1, status: 'deferred' as const, reason: 'read-only', spaceId: '' },
  ]) {
    using local = localOutbox(1)
    const client = { whoami, sync: async () => ({ results: [result] }) }
    await expect(syncRecord({ ...options(local), client: client as never })).rejects.toThrow(
      'record sync response contained an invalid',
    )
    expect(local.query('SELECT attempts,synced_at,quarantined_at FROM outbox').get()).toEqual({
      attempts: 0,
      synced_at: null,
      quarantined_at: null,
    })
  }
})

test('whole-request auth, server, and old-route failures leave the batch pending', async () => {
  for (const failure of [
    new RecordApiRequestError('credentials refused', 'refused', 401),
    new RecordApiRequestError('server unavailable', 'unreachable', 500),
    new RecordApiRequestError('not found', 'refused', 404),
  ]) {
    using local = localOutbox(1)
    const client = { whoami, sync: async () => Promise.reject(failure) }
    await expect(syncRecord({ ...options(local), client })).rejects.toThrow(
      failure.status === 404 ? 'release the hosted API' : failure.message,
    )
    expect(local.query('SELECT attempts,synced_at,quarantined_at FROM outbox').get()).toEqual({
      attempts: 0,
      synced_at: null,
      quarantined_at: null,
    })
  }
})
