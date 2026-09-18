import { expect, test } from 'bun:test'
import { assertBranchHasNoAliveOwner } from './branch-owner-guard.ts'

test('an absent branch needs no owner lookup', () => {
  expect(() =>
    assertBranchHasNoAliveOwner({
      branch: undefined,
      conversationRootId: null,
      projectId: null,
      projectName: null,
    }),
  ).not.toThrow()
})
