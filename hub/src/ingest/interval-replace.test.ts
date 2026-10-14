import { expect, test } from 'bun:test'
import { decideCollectorReplace } from './interval-replace.ts'

const existing = (recordId: string, startAt: string, ref = 'claude:file:0') => ({
  record_id: recordId,
  source: 'claude',
  ref,
  start_at: startAt,
})

const recomputed = (startAt: string, endAt: string, ref = 'claude:file:0') => ({
  source: 'claude',
  ref,
  start_at: startAt,
  end_at: endAt,
})

test('unchanged start updates in place and keeps the UUID', () => {
  const decision = decideCollectorReplace(
    [existing('keep-id', '2026-10-08T10:00:00.000Z')],
    [recomputed('2026-10-08T10:00:00.000Z', '2026-10-08T10:05:00.000Z')],
  )
  expect(decision).toEqual({
    updates: [
      {
        source: 'claude',
        ref: 'claude:file:0',
        start_at: '2026-10-08T10:00:00.000Z',
        end_at: '2026-10-08T10:05:00.000Z',
        record_id: 'keep-id',
      },
    ],
    inserts: [],
    deletes: [],
  })
})

test('changed start yields one insert and one delete', () => {
  const decision = decideCollectorReplace(
    [existing('old-id', '2026-10-08T10:00:00.000Z')],
    [recomputed('2026-10-08T10:01:00.000Z', '2026-10-08T10:05:00.000Z')],
  )
  expect(decision.updates).toEqual([])
  expect(decision.inserts).toEqual([
    recomputed('2026-10-08T10:01:00.000Z', '2026-10-08T10:05:00.000Z'),
  ])
  expect(decision.deletes).toEqual(['old-id'])
})

test('a row that only grew longer is an update', () => {
  const decision = decideCollectorReplace(
    [existing('keep-id', '2026-10-08T10:00:00.000Z')],
    [recomputed('2026-10-08T10:00:00.000Z', '2026-10-08T11:00:00.000Z')],
  )
  expect(decision.updates).toHaveLength(1)
  expect(decision.updates[0]?.record_id).toBe('keep-id')
  expect(decision.updates[0]?.end_at).toBe('2026-10-08T11:00:00.000Z')
  expect(decision.inserts).toEqual([])
  expect(decision.deletes).toEqual([])
})

test('a split updates the surviving start and inserts the new start', () => {
  const decision = decideCollectorReplace(
    [existing('keep-id', '2026-10-08T10:00:00.000Z')],
    [
      recomputed('2026-10-08T10:00:00.000Z', '2026-10-08T10:10:00.000Z'),
      recomputed('2026-10-08T10:20:00.000Z', '2026-10-08T10:30:00.000Z'),
    ],
  )
  expect(decision.updates.map((row) => [row.record_id, row.start_at])).toEqual([
    ['keep-id', '2026-10-08T10:00:00.000Z'],
  ])
  expect(decision.inserts.map((row) => row.start_at)).toEqual(['2026-10-08T10:20:00.000Z'])
  expect(decision.deletes).toEqual([])
})

test('preserved refs stay out of the pure replacement decision deletes', () => {
  const decision = decideCollectorReplace(
    [
      existing('keep-id', '2026-10-08T10:00:00.000Z', 'orch:1:turn:1'),
      existing('delete-id', '2026-10-08T11:00:00.000Z', 'orch:1:turn:2'),
    ],
    [],
    new Set(['orch:1:turn:1']),
  )
  expect(decision).toEqual({ updates: [], inserts: [], deletes: ['delete-id'] })
})
