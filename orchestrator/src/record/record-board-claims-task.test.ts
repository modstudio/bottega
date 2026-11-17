import { expect, test } from 'bun:test'
import type { ClaimSubject } from '../board/board-claim-policy.ts'
import { decideHostedTaskClaimTake } from './record-board-claims.ts'

const task = { kind: 'task', value: 'DEV-1' } satisfies ClaimSubject

test('hosted task take requires an owned open stage and then permits takeover', () => {
  expect(decideHostedTaskClaimTake({ subject: task, ownsOpenStage: false })).toEqual({
    admitted: false,
    refusal: 'task claims follow task cursors; run workflow compose … --arg key=DEV-1 instead',
  })
  expect(
    decideHostedTaskClaimTake({
      subject: task,
      ownsOpenStage: true,
      conflictingClaim: true,
      foreignLiveConflict: true,
    }),
  ).toEqual({
    admitted: true,
    decision: 'take-over',
  })
})
