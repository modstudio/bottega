import { expect, test } from 'bun:test'
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

test('keeps the row-count limit', () => {
  expect(plan([candidate(1, 10), candidate(2, 10)], { countLimit: 1 }).send).toEqual([
    candidate(1, 10),
  ])
})
