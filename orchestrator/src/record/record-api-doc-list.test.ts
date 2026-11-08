import { expect, test } from 'bun:test'
import { recordDocListPage } from './record-api-doc-list.ts'
import { encodeRecordCursor, recordCursorAt } from './record-cursor.ts'
import type { RecordDoc } from './record-docs.ts'

test('an unreadable row inside a full doc page advances the walk but not the safe cursor', () => {
  const firstId = '01990000-0000-7000-8000-000000000001'
  const lastId = '01990000-0000-7000-8000-000000000002'
  const unreadableId = '01990000-0000-7000-8000-000000000099'
  const updatedAt = '2026-11-07T12:00:00.000Z'
  const first = {
    id: firstId,
    updatedAt,
    [recordCursorAt]: '2026-11-07T12:00:00.000000Z',
  } as unknown as RecordDoc
  const last = {
    id: lastId,
    updatedAt,
    [recordCursorAt]: '2026-11-07T12:00:02.000000Z',
  } as unknown as RecordDoc
  const firstCursor = encodeRecordCursor({
    at: '2026-11-07T12:00:00.000000Z',
    id: firstId,
  })
  const unreadableCursor = encodeRecordCursor({
    at: '2026-11-07T12:00:01.000000Z',
    id: unreadableId,
  })
  expect(
    recordDocListPage(
      [
        { readable: first },
        {
          unreadable: {
            id: unreadableId,
            reason: `hosted document project/example/bad (${unreadableId}) column doc.source_files is not a JSON list`,
          },
          cursor: { at: '2026-11-07T12:00:01.000000Z', id: unreadableId },
        },
        { readable: last },
      ],
      2,
    ),
  ).toEqual({
    items: [first],
    unreadable: [
      {
        id: unreadableId,
        reason: expect.stringContaining('doc.source_files is not a JSON list'),
      },
    ],
    nextCursor: unreadableCursor,
    endCursor: firstCursor,
  })
})

test('an unreadable lookahead row is left for the next doc page', () => {
  const firstId = '01990000-0000-7000-8000-000000000001'
  const secondId = '01990000-0000-7000-8000-000000000002'
  const unreadableId = '01990000-0000-7000-8000-000000000099'
  const updatedAt = '2026-11-07T12:00:00.000Z'
  const first = {
    id: firstId,
    updatedAt,
    [recordCursorAt]: '2026-11-07T12:00:00.000000Z',
  } as unknown as RecordDoc
  const second = {
    id: secondId,
    updatedAt,
    [recordCursorAt]: '2026-11-07T12:00:01.000000Z',
  } as unknown as RecordDoc

  expect(
    recordDocListPage(
      [
        { readable: first },
        { readable: second },
        {
          unreadable: { id: unreadableId, reason: 'bad source_files' },
          cursor: { at: '2026-11-07T12:00:02.000000Z', id: unreadableId },
        },
      ],
      2,
    ),
  ).toEqual({
    items: [first, second],
    unreadable: [],
    nextCursor: encodeRecordCursor({
      at: '2026-11-07T12:00:01.000000Z',
      id: secondId,
    }),
    endCursor: encodeRecordCursor({
      at: '2026-11-07T12:00:01.000000Z',
      id: secondId,
    }),
  })
})
