import { expect, test } from 'bun:test'
import {
  blockedOutboxLines,
  quarantinedOutboxLines,
  readOnlyDeferredLines,
} from './record-sync-command.ts'

test('sync presentation names each quarantined row with its kind and error', () => {
  expect(
    quarantinedOutboxLines([
      {
        id: 28138,
        kind: 'score',
        recordId: 'record-id',
        error: "failure kind 'context' is not evidence",
        attempts: 149,
        quarantinedAt: '2026-09-28T00:00:00.000Z',
      },
    ]),
  ).toEqual(["quarantined 28138\tscore\tfailure kind 'context' is not evidence"])
})

test('sync presentation names a row blocked by its retired parent', () => {
  expect(
    blockedOutboxLines([
      { id: 29153, kind: 'question', parentRecordId: '01990000-0000-7000-8000-parent' },
    ]),
  ).toEqual(['blocked 29153\tquestion\tretired parent 01990000-0000-7000-8000-parent'])
})

test('sync presentation reports read-only deferred rows by space', () => {
  // Production break watched: omit read-only deferred rows from sync presentation.
  expect(readOnlyDeferredLines([{ spaceId: 'space-a', rows: 2 }])).toEqual([
    'deferred 2\tread-only space space-a',
  ])
})
