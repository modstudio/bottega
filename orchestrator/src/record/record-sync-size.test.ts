import { Database } from 'bun:sqlite'
import { expect, mock, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { syncRecord } from './record-sync.ts'
import {
  RECORD_SYNC_CLIENT_MAX_REQUEST_BYTES,
  RECORD_SYNC_MAX_PAYLOAD_BYTES,
  type RecordSyncRequest,
} from './record-sync-contract.ts'

const STAMP = '2026-09-15T01:01:00.000Z'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const MACHINE_ID = '01990000-0000-7000-8000-000000000002'

function localOutbox(
  rows: Array<{ id: number; kind?: string; recordId?: string; payload: string }>,
): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  const insert = local.query(
    'INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (?,?,?,?,?)',
  )
  for (const row of rows)
    insert.run(row.id, row.kind ?? 'run', row.recordId ?? `record-${row.id}`, row.payload, STAMP)
  return local
}

const whoami = async () => ({
  user: { id: MACHINE_ID },
  activeSpaceId: SPACE_ID,
  personalSpaceId: SPACE_ID,
  memberships: [
    { space_id: SPACE_ID, name: 'Space', slug: 'space', role: 'owner', permission: 'write' },
  ],
})

function options(local: Database, requests: RecordSyncRequest[]) {
  return {
    local,
    now: () => STAMP,
    identity: { id: MACHINE_ID, name: 'test-machine' },
    client: {
      whoami,
      sync: mock(async (request: RecordSyncRequest) => {
        requests.push(request)
        return { results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })) }
      }),
    },
  }
}

test('an oversized first row is quarantined without blocking a legal later row', async () => {
  const local = localOutbox([
    { id: 1, payload: 'x'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES + 1) },
    { id: 2, payload: '{}' },
  ])
  const requests: RecordSyncRequest[] = []
  const syncOptions = options(local, requests)

  expect(await syncRecord(syncOptions)).toMatchObject({
    pushed: 1,
    failed: 1,
    pending: 0,
    quarantined: [{ id: 1, kind: 'run', attempts: 1 }],
  })
  const rows = local
    .query<{ synced_at: string | null; quarantine_reason: string | null }, []>(
      'SELECT synced_at,quarantine_reason FROM outbox ORDER BY id',
    )
    .all()
  expect(rows[0]!.quarantine_reason).toContain(
    `${RECORD_SYNC_MAX_PAYLOAD_BYTES + 1} bytes, exceeding the ${RECORD_SYNC_MAX_PAYLOAD_BYTES} byte limit`,
  )
  expect(rows[0]!.quarantine_reason).toContain(`${PLATFORM_SLUG} record outbox retire <row-id>`)
  expect(rows[1]!.synced_at).toBe(STAMP)
  expect(requests[0]!.rows.map((row) => row.id)).toEqual([2])

  expect(await syncRecord(syncOptions)).toMatchObject({ pushed: 0, failed: 0, pending: 0 })
  expect(requests.at(-1)!.rows).toEqual([])
  local.close()
})

test('actual serialized requests stay within budget and retain UTF-8 row order', async () => {
  const payloads = [
    '\u0001'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
    'é\n'.repeat(Math.floor(RECORD_SYNC_MAX_PAYLOAD_BYTES / 3)),
    'x'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
    'y'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
    'z'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
    'w'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
    'q'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
    'r'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
  ]
  using local = localOutbox(payloads.map((payload, index) => ({ id: index + 1, payload })))
  const requests: RecordSyncRequest[] = []

  expect(await syncRecord(options(local, requests))).toMatchObject({
    pushed: 7,
    failed: 1,
    pending: 0,
  })
  expect(requests.map((request) => request.rows.length)).toEqual([3, 3, 1])
  expect(requests.flatMap((request) => request.rows.map((row) => row.id))).toEqual([
    2, 3, 4, 5, 6, 7, 8,
  ])
  for (const request of requests) {
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(
      RECORD_SYNC_CLIENT_MAX_REQUEST_BYTES,
    )
  }
  const reason = local
    .query<{ quarantine_reason: string }, []>('SELECT quarantine_reason FROM outbox WHERE id=1')
    .get()!.quarantine_reason
  const serializedBytes = new TextEncoder().encode(
    JSON.stringify({ id: 1, kind: 'run', payload: payloads[0], spaceHint: null }),
  ).byteLength
  expect(reason).toContain(`serialized row is ${serializedBytes} bytes`)
  expect(reason).toContain(`${RECORD_SYNC_CLIENT_MAX_REQUEST_BYTES} byte client request budget`)
})

test('a request-oversized legal payload is quarantined and later rows still sync', async () => {
  using local = localOutbox([
    { id: 1, payload: '\u0001'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES) },
    { id: 2, payload: '{}' },
  ])
  const requests: RecordSyncRequest[] = []

  expect(await syncRecord(options(local, requests))).toMatchObject({
    pushed: 1,
    failed: 1,
    pending: 0,
  })
  expect(requests.flatMap((request) => request.rows.map((row) => row.id))).toEqual([2])
  expect(
    local
      .query<{ quarantine_reason: string }, []>('SELECT quarantine_reason FROM outbox WHERE id=1')
      .get()!.quarantine_reason,
  ).toContain(`${PLATFORM_SLUG} record outbox retire <row-id>`)
})

test('a child of a size-quarantined parent waits while an independent row syncs', async () => {
  const parentPayload = JSON.stringify({
    id: 'parent',
    padding: 'x'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES),
  })
  using local = localOutbox([
    { id: 1, recordId: 'parent', payload: parentPayload },
    { id: 2, recordId: 'child', payload: JSON.stringify({ id: 'child', parentRunId: 'parent' }) },
    { id: 3, recordId: 'independent', payload: JSON.stringify({ id: 'independent' }) },
  ])
  const requests: RecordSyncRequest[] = []

  expect(await syncRecord(options(local, requests))).toMatchObject({
    pushed: 1,
    failed: 1,
    pending: 1,
  })
  expect(requests.flatMap((request) => request.rows.map((row) => row.id))).toEqual([3])
  expect(local.query('SELECT quarantined_at FROM outbox WHERE id=1').get()).toEqual({
    quarantined_at: STAMP,
  })
  expect(local.query('SELECT synced_at FROM outbox WHERE id=2').get()).toEqual({ synced_at: null })
})
