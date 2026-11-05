import { expect, test } from 'bun:test'
import {
  decodeRecordChangeCursor,
  encodeRecordChangeCursor,
  recordChangePage,
  recordChangeResetRequired,
} from './record-changes.ts'

test('record change cursors round trip and reject malformed input', () => {
  const cursor = { xid: 12n, seq: 20n }
  expect(decodeRecordChangeCursor(encodeRecordChangeCursor(cursor))).toEqual(cursor)
  expect(() => decodeRecordChangeCursor('bad')).toThrow('malformed')
})

test('a record change reset orders cursors by transaction before sequence', () => {
  const horizon = { xid: 12n, seq: 20n }
  expect(recordChangeResetRequired(null, horizon)).toBe(true)
  expect(recordChangeResetRequired({ xid: 12n, seq: 19n }, horizon)).toBe(true)
  expect(recordChangeResetRequired({ xid: 11n, seq: 99n }, horizon)).toBe(true)
  expect(recordChangeResetRequired({ xid: 13n, seq: 1n }, horizon)).toBe(false)
  expect(recordChangeResetRequired(horizon, horizon)).toBe(false)
})

test('a record change page advances its pair cursor to the last returned row', () => {
  const row = (xid: number, seq: number) => ({
    xid: String(xid),
    seq: String(seq),
    table_name: 'project',
    row_id: `row-${seq}`,
    space_id: '01990000-0000-7000-8000-000000001300',
    op: 'upsert' as const,
  })
  const after = { xid: 10n, seq: 10n }
  const page = recordChangePage(after, [row(11, 13), row(12, 12)])
  expect(page.changes.map((change) => [change.xid, change.seq])).toEqual([
    [11n, 13n],
    [12n, 12n],
  ])
  expect(page.cursor).toEqual({ xid: 12n, seq: 12n })
  expect(recordChangePage(after, []).cursor).toBe(after)
})
