import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineId } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { syncRecord } from './record-sync.ts'
import { RECORD_SYNC_BATCH_SIZE, type RecordSyncRowResult } from './record-sync-contract.ts'

const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const USER_ID = '01990000-0000-7000-8000-000000000002'
const READ_ID = '01990000-0000-7000-8000-000000000003'
const SNAPSHOT_ID = '01990000-0000-7000-8000-000000000004'
const STAMP = '2026-10-13T04:00:00.000Z'

test('one sync pushes a review read before its dependent triage snapshot', async () => {
  const local = migratedTestDatabase()
  const identity = { id: machineId(), name: 'test-machine' }
  const read = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.review_read.columns.map((column) => [column, null]),
  )
  Object.assign(read, {
    id: READ_ID,
    spaceId: SPACE_ID,
    projectName: PLATFORM_SLUG,
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
    projectName: PLATFORM_SLUG,
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
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,1,'review_read',?,?,?),
       ('01990000-0000-7000-8000-000000000002',2,'landing_triage_snapshot',?,?,?)`,
    )
    .run(
      newRecordId(),
      READ_ID,
      JSON.stringify(read),
      STAMP,
      SNAPSHOT_ID,
      JSON.stringify(snapshot),
      STAMP,
    )
  const batches: string[][] = []

  try {
    expect(
      await syncRecord({
        local,
        identity,
        projectSpaces: { [PLATFORM_SLUG]: SPACE_ID },
        client: {
          whoami: async () => ({
            user: { id: USER_ID },
            activeSpaceId: SPACE_ID,
            personalSpaceId: SPACE_ID,
            memberships: [{ space_id: SPACE_ID, slug: PLATFORM_SLUG, permission: 'write' }],
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
    expect(batches).toEqual([['review_read', 'landing_triage_snapshot']])
  } finally {
    local.close()
  }
})

function dependencyClient(
  batches: number[][],
  resultFor: (
    id: number,
  ) =>
    | { status: 'synced' }
    | { status: 'quarantined'; reason: string }
    | { status: 'deferred'; reason: string; spaceId: string },
) {
  return {
    whoami: async () => ({
      user: { id: USER_ID },
      activeSpaceId: SPACE_ID,
      personalSpaceId: SPACE_ID,
      memberships: [{ space_id: SPACE_ID, slug: PLATFORM_SLUG, permission: 'write' }],
    }),
    sync: async (request: { rows: Array<{ id: number }> }) => {
      batches.push(request.rows.map((row) => row.id))
      return {
        results: request.rows.map(
          (row): RecordSyncRowResult => ({ id: row.id, ...resultFor(row.id) }),
        ),
      }
    },
  }
}

function insertOutboxRow(
  local: Database,
  id: number,
  kind: string,
  recordId: string,
  payload: Record<string, unknown>,
): void {
  local
    .query('INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,?,?,?,?,?)')
    .run(newRecordId(), id, kind, recordId, JSON.stringify(payload), STAMP)
}

test('one sync request carries a review, lens, and finding dependency chain', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'review', 'review-1', { id: 'review-1' })
  insertOutboxRow(local, 2, 'review_lens', 'lens-1', {
    id: 'lens-1',
    reviewId: 'review-1',
    runId: null,
  })
  insertOutboxRow(local, 3, 'review_finding', 'finding-1', {
    id: 'finding-1',
    reviewId: 'review-1',
    reviewLensId: 'lens-1',
  })
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, () => ({ status: 'synced' })),
    }),
  ).toMatchObject({ pushed: 3, failed: 0, pending: 0 })
  expect(batches).toEqual([[1, 2, 3]])
})

test('mixed dependent rows fill count-limited batches instead of stopping per family', async () => {
  using local = migratedTestDatabase()
  const familyCount = RECORD_SYNC_BATCH_SIZE + 1
  for (let family = 0; family < familyCount; family++) {
    const parentId = family * 2 + 1
    insertOutboxRow(local, parentId, 'review', `review-${family}`, { id: `review-${family}` })
    insertOutboxRow(local, parentId + 1, 'review_lens', `lens-${family}`, {
      id: `lens-${family}`,
      reviewId: `review-${family}`,
      runId: null,
    })
  }
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, () => ({ status: 'synced' })),
    }),
  ).toMatchObject({ pushed: familyCount * 2, failed: 0, pending: 0 })
  expect(batches.map((batch) => batch.length)).toEqual([
    RECORD_SYNC_BATCH_SIZE,
    RECORD_SYNC_BATCH_SIZE,
    2,
  ])
})

test('a quarantined same-batch parent leaves its refused child pending', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'run', 'run-1', { id: 'run-1' })
  insertOutboxRow(local, 2, 'score', 'run-1', { id: 'run-1' })
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, () => ({ status: 'quarantined', reason: 'refused' })),
    }),
  ).toMatchObject({ pushed: 0, failed: 1, pending: 1 })
  expect(batches).toEqual([[1, 2]])
  expect(
    local.query('SELECT id,synced_at,quarantined_at,attempts FROM outbox ORDER BY id').all(),
  ).toEqual([
    { id: 1, synced_at: null, quarantined_at: STAMP, attempts: 1 },
    { id: 2, synced_at: null, quarantined_at: null, attempts: 0 },
  ])
})

test('a deferred same-batch parent leaves its child pending', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'run', 'run-1', { id: 'run-1' })
  insertOutboxRow(local, 2, 'score', 'run-1', { id: 'run-1' })
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, () => ({
        status: 'deferred',
        reason: 'read-only',
        spaceId: SPACE_ID,
      })),
    }),
  ).toMatchObject({ pushed: 0, failed: 0, pending: 2 })
  expect(batches).toEqual([[1, 2]])
  expect(local.query('SELECT attempts FROM outbox ORDER BY id').all()).toEqual([
    { attempts: 1 },
    { attempts: 0 },
  ])

  const retryBatches: number[][] = []
  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(retryBatches, () => ({ status: 'synced' })),
    }),
  ).toMatchObject({ pushed: 2, failed: 0, pending: 0 })
  expect(retryBatches).toEqual([[1, 2]])
  expect(local.query('SELECT synced_at FROM outbox ORDER BY id').all()).toEqual([
    { synced_at: STAMP },
    { synced_at: STAMP },
  ])
})

test('a synced copy satisfies a parent identity when a later copy is refused', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'review', 'review-1', { id: 'review-1' })
  insertOutboxRow(local, 2, 'review', 'review-1', { id: 'review-1' })
  insertOutboxRow(local, 3, 'review_lens', 'lens-1', {
    id: 'lens-1',
    reviewId: 'review-1',
    runId: null,
  })
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, (id) =>
        id === 2 ? { status: 'quarantined', reason: 'duplicate refused' } : { status: 'synced' },
      ),
    }),
  ).toMatchObject({ pushed: 2, failed: 1, pending: 0 })
  expect(batches).toEqual([[1, 2, 3]])
  expect(local.query('SELECT id,synced_at,quarantined_at FROM outbox ORDER BY id').all()).toEqual([
    { id: 1, synced_at: STAMP, quarantined_at: null },
    { id: 2, synced_at: null, quarantined_at: STAMP },
    { id: 3, synced_at: STAMP, quarantined_at: null },
  ])
})

test('a child stays pending when every copy of its parent identity is refused', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'review', 'review-1', { id: 'review-1' })
  insertOutboxRow(local, 2, 'review', 'review-1', { id: 'review-1' })
  insertOutboxRow(local, 3, 'review_lens', 'lens-1', {
    id: 'lens-1',
    reviewId: 'review-1',
    runId: null,
  })
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, () => ({ status: 'quarantined', reason: 'refused' })),
    }),
  ).toMatchObject({ pushed: 0, failed: 2, pending: 1 })
  expect(batches).toEqual([[1, 2, 3]])
  expect(local.query('SELECT id,quarantined_at,attempts FROM outbox ORDER BY id').all()).toEqual([
    { id: 1, quarantined_at: STAMP, attempts: 1 },
    { id: 2, quarantined_at: STAMP, attempts: 1 },
    { id: 3, quarantined_at: null, attempts: 0 },
  ])
})

test('a child is not sent while another parent identity remains outside the batch', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'review', 'review-1', { id: 'review-1' })
  insertOutboxRow(local, 2, 'review_finding', 'finding-1', {
    id: 'finding-1',
    reviewId: 'review-1',
    reviewLensId: 'lens-1',
  })
  insertOutboxRow(local, 3, 'review_lens', 'lens-1', {
    id: 'lens-1',
    reviewId: 'review-1',
    runId: null,
  })
  const batches: number[][] = []

  expect(
    await syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, () => ({ status: 'synced' })),
    }),
  ).toMatchObject({ pushed: 3, failed: 0, pending: 0 })
  expect(batches).toEqual([[1], [3], [2]])
})

test('a synced child of a quarantined same-batch parent fails without marking the child', async () => {
  using local = migratedTestDatabase()
  insertOutboxRow(local, 1, 'run', 'run-1', { id: 'run-1' })
  insertOutboxRow(local, 2, 'score', 'run-1', { id: 'run-1' })
  const batches: number[][] = []

  await expect(
    syncRecord({
      local,
      now: () => STAMP,
      identity: { id: machineId(), name: 'test-machine' },
      client: dependencyClient(batches, (id) =>
        id === 1 ? { status: 'quarantined', reason: 'refused' } : { status: 'synced' },
      ),
    }),
  ).rejects.toThrow('record sync contract violation: row 2')
  expect(local.query('SELECT synced_at FROM outbox WHERE id=2').get()).toEqual({ synced_at: null })
})
