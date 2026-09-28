import { expect, test } from 'bun:test'
import { quarantinedOutboxLines } from './record-sync-command.ts'

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
