import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  blockedOutboxLines,
  quarantinedOutboxLines,
  quarantinedParentHeldLines,
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

test('sync presentation names a quarantined parent and its waiting rows', () => {
  expect(
    quarantinedParentHeldLines([
      { id: 48, kind: 'run', quarantinedAt: '2026-10-24T12:00:00.000Z', rows: 3 },
    ]),
  ).toEqual([
    `held: orch:48 run is quarantined at 2026-10-24T12:00:00.000Z; 3 rows wait on it; retry it with ${PLATFORM_SLUG} record outbox retry orch:48, or retire it with ${PLATFORM_SLUG} record outbox retire orch:48 --reason <text>`,
  ])
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
