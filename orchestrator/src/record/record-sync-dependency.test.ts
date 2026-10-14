import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { machineId } from '../../../shared/machine-config.ts'
import { applyMigrations } from '../database/migrations.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { syncRecord } from './record-sync.ts'

const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const USER_ID = '01990000-0000-7000-8000-000000000002'
const READ_ID = '01990000-0000-7000-8000-000000000003'
const SNAPSHOT_ID = '01990000-0000-7000-8000-000000000004'
const STAMP = '2026-10-13T04:00:00.000Z'

test('one sync pushes a review read before its dependent triage snapshot', async () => {
  const local = new Database(':memory:')
  applyMigrations(local)
  const identity = { id: machineId(), name: 'test-machine' }
  const read = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.review_read.columns.map((column) => [column, null]),
  )
  Object.assign(read, {
    id: READ_ID,
    spaceId: SPACE_ID,
    projectName: 'bottega',
    machineId: identity.id,
    localId: 41,
    branch: 'DEV-1307-proof',
    tip: 'tip',
    patchId: 'patch',
    pathSet: [],
    tier: 2,
    note: 'reviewed',
    recordedAt: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  const snapshot = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.landing_triage_snapshot.columns.map((column) => [column, null]),
  )
  Object.assign(snapshot, {
    id: SNAPSHOT_ID,
    spaceId: SPACE_ID,
    projectName: 'bottega',
    machineId: identity.id,
    localId: 42,
    branch: 'DEV-1307-proof',
    tip: 'tip',
    tree: 'tree',
    prNumber: 1307,
    reviewIds: [],
    patchId: 'patch',
    tier: 2,
    lensRounds: 1,
    findingCount: 0,
    admissionPath: 'architect_read',
    readId: READ_ID,
    at: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  local
    .query(
      `INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES
       (1,'review_read',?,?,?),
       (2,'landing_triage_snapshot',?,?,?)`,
    )
    .run(READ_ID, JSON.stringify(read), STAMP, SNAPSHOT_ID, JSON.stringify(snapshot), STAMP)
  const batches: string[][] = []

  try {
    expect(
      await syncRecord({
        local,
        identity,
        projectSpaces: { bottega: SPACE_ID },
        client: {
          whoami: async () => ({
            user: { id: USER_ID },
            activeSpaceId: SPACE_ID,
            personalSpaceId: SPACE_ID,
            memberships: [{ space_id: SPACE_ID, slug: 'bottega', permission: 'write' }],
          }),
          sync: async (request) => {
            batches.push(request.rows.map((row) => row.kind))
            return {
              results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
            }
          },
        },
      }),
    ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })
    expect(batches).toEqual([['review_read'], ['landing_triage_snapshot']])
  } finally {
    local.close()
  }
})
