import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  decodeRecordCursor,
  encodeRecordCursor,
  pageRecordItems,
  parseStoredRecordCursor,
  recordCursorAt,
  recordCursorOf,
} from './record-cursor.ts'

const id = newRecordId()
const milliseconds = '2026-10-09T12:34:56.789Z'
const microseconds = '2026-10-09T12:34:56.789123Z'

test('parses stored JSON cursors without migration', () => {
  expect(parseStoredRecordCursor(JSON.stringify({ at: microseconds, id }), true)).toEqual({
    cursor: { at: microseconds, id },
    migrated: false,
  })
})

test('migrates an accepted raw timestamp to the nil-id replay sentinel', () => {
  expect(parseStoredRecordCursor(milliseconds, true)).toEqual({
    cursor: { at: milliseconds, id: '00000000-0000-0000-0000-000000000000' },
    migrated: true,
  })
})

test('rejects junk and a raw timestamp where legacy timestamps are not accepted', () => {
  expect(parseStoredRecordCursor('junk', true)).toEqual({ invalid: true })
  expect(parseStoredRecordCursor(milliseconds, false)).toEqual({ invalid: true })
})

test('pages with the exact service timestamp and returns an end cursor on the final page', () => {
  const row = { id, updatedAt: milliseconds, [recordCursorAt]: microseconds }
  expect(recordCursorOf(row)).toEqual({ at: microseconds, id })
  const page = pageRecordItems([row], 1, recordCursorOf, true)
  expect(page.nextCursor).toBeNull()
  expect(decodeRecordCursor(page.endCursor!)).toEqual({ at: microseconds, id })
  expect(JSON.parse(JSON.stringify(page.items[0]))).toEqual({ id, updatedAt: milliseconds })
  expect(decodeRecordCursor(encodeRecordCursor({ at: microseconds, id }))).toEqual({
    at: microseconds,
    id,
  })
})
