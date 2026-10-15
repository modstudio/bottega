import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { planRecordSyncBatch, type RecordSyncBatchCandidate } from './record-sync-batch.ts'

const candidate = (
  id: number,
  payloadBytes: number,
  serializedBytes = payloadBytes,
): RecordSyncBatchCandidate => ({ id, kind: 'run', payloadBytes, serializedBytes })

const plan = (
  rows: RecordSyncBatchCandidate[],
  overrides: Partial<Parameters<typeof planRecordSyncBatch>[0]> = {},
) =>
  planRecordSyncBatch({
    rows,
    emptyRequestBytes: 10,
    payloadLimit: 100,
    requestLimit: 1_000,
    countLimit: 100,
    ...overrides,
  })

test('quarantines an oversized first row and sends the later legal row', () => {
  const result = plan([candidate(1, 101), candidate(2, 100)])

  expect(result.quarantine).toEqual([
    expect.objectContaining({ id: 1, kind: 'run', payloadBytes: 101 }),
  ])
  expect(result.quarantine[0]!.reason).toContain('101 bytes, exceeding the 100 byte limit')
  expect(result.send.map((row) => row.id)).toEqual([2])
})

test('splits request-sized batches without reordering rows', () => {
  const rows = [candidate(1, 10, 50), candidate(2, 10, 50), candidate(3, 10, 50)]
  const first = plan(rows, { requestLimit: 111 })
  const second = plan(rows.slice(first.send.length), { requestLimit: 111 })

  expect(first.send.map((row) => row.id)).toEqual([1, 2])
  expect(second.send.map((row) => row.id)).toEqual([3])
})

test('sends a payload exactly at the ceiling', () => {
  expect(plan([candidate(1, 100)]).send.map((row) => row.id)).toEqual([1])
})

test('classifies every row until a non-empty batch reaches a boundary', () => {
  const rows = [
    candidate(1, 101, 10),
    candidate(2, 100, 1_001),
    candidate(3, 10, 100),
    candidate(4, 10, 1_001),
    candidate(5, 10, 10),
  ]
  const result = plan(rows)

  expect(result.quarantine.map((row) => row.id)).toEqual([1, 2])
  expect(result.quarantine[1]!.reason).toContain(
    'serialized row is 1001 bytes and requires a 1011 byte request, exceeding the 1000 byte client request budget',
  )
  expect(result.quarantine[1]!.reason).toContain(
    `${PLATFORM_SLUG} record outbox retire orch:<row-id>`,
  )
  expect(result.send.map((row) => row.id)).toEqual([3])
  const classified = new Set([...result.quarantine, ...result.send].map((row) => row.id))
  expect(rows.filter((row) => !classified.has(row.id)).map((row) => row.id)).toEqual([4, 5])
})
