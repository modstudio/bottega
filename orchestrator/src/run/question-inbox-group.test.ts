import { describe, expect, test } from 'bun:test'
import { questionInboxGroup } from './question-inbox-group.ts'

describe('question inbox group', () => {
  test.each([
    ['worker', 'session-a', false, 'session-a', 'worker'],
    ['worker', 'session-a', true, 'session-a', 'user'],
    ['workflow', 'session-a', false, 'session-a', 'user'],
    ['worker', 'session-b', false, 'session-a', 'foreign'],
    ['worker', 'session-b', true, 'session-a', 'foreign'],
    ['worker', null, false, 'session-a', 'unowned'],
    ['worker', null, true, 'session-a', 'unowned'],
  ] as const)(
    '%s question owned by %s with operator wait %s for %s is %s',
    (kind, ownerSessionId, awaitingOperator, callerSessionId, expected) => {
      expect(questionInboxGroup({ kind, ownerSessionId, awaitingOperator, callerSessionId })).toBe(
        expected,
      )
    },
  )
})
