import { expect, test } from 'bun:test'
import type { ClaimSubject } from '../board/board-claim-policy.ts'
import { crossUserTaskClaimTakeRefusal, taskClaimTakeRefusal } from './record-board-claims.ts'

const task = { kind: 'task', value: 'DEV-1' } satisfies ClaimSubject

test('hosted task take requires an owned open stage', () => {
  expect(taskClaimTakeRefusal(task, false)).toBe(
    'task claims follow task cursors; run workflow compose … --arg key=DEV-1 instead',
  )
  expect(taskClaimTakeRefusal(task, true)).toBeNull()
})

test('hosted task takeover refuses a different user but admits the same user handoff', () => {
  const conflictingLiveClaims = [{ holderUserId: 'user-a', holderSession: 'session-a' }]
  expect(
    crossUserTaskClaimTakeRefusal({
      subject: task,
      userId: 'user-b',
      conflictingLiveClaims,
    }),
  ).toBe(
    'task claim is held by user user-a session session-a; that holder must abandon the cursor, or wait for the claim to lapse',
  )
  expect(
    crossUserTaskClaimTakeRefusal({
      subject: task,
      userId: 'user-a',
      conflictingLiveClaims,
    }),
  ).toBeNull()
})
