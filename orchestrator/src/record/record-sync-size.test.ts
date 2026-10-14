import { Database } from 'bun:sqlite'
import { expect, mock, test } from 'bun:test'
import { syncRecord } from './record-sync.ts'
import { RECORD_SYNC_MAX_PAYLOAD_BYTES, type RecordSyncRequest } from './record-sync-contract.ts'

const STAMP = '2026-09-15T01:01:00.000Z'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const MACHINE_ID = '01990000-0000-7000-8000-000000000002'

function localOutbox(): Database {
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
  local
    .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (1,'run','one',?,?)")
    .run('x'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES + 1), STAMP)
  local
    .query(
      "INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (2,'run','two','{}',?)",
    )
    .run(STAMP)
  return local
}

test('an oversized first row is quarantined without blocking a legal later row', async () => {
  const local = localOutbox()
  const uploaded = mock(async (request: RecordSyncRequest) => ({
    results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
  }))
  const options = {
    local,
    now: () => STAMP,
    identity: { id: MACHINE_ID, name: 'test-machine' },
    client: {
      whoami: async () => ({
        user: { id: MACHINE_ID },
        activeSpaceId: SPACE_ID,
        personalSpaceId: SPACE_ID,
        memberships: [
          { space_id: SPACE_ID, name: 'Space', slug: 'space', role: 'owner', permission: 'write' },
        ],
      }),
      sync: uploaded,
    },
  }

  expect(await syncRecord(options)).toMatchObject({
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
  expect(rows[0]!.quarantine_reason).toContain('orch record outbox retire <row-id>')
  expect(rows[1]!.synced_at).toBe(STAMP)
  expect(uploaded.mock.calls[0]![0].rows.map((row) => row.id)).toEqual([2])

  expect(await syncRecord(options)).toMatchObject({ pushed: 0, failed: 0, pending: 0 })
  expect(uploaded.mock.calls.at(-1)![0].rows).toEqual([])
  local.close()
})
