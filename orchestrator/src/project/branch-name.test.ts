import { expect, test } from 'bun:test'
import { isCommitShapedBranch } from './branch-name.ts'

test('commit-shaped branches are lowercase hex between 7 and 40 characters', () => {
  expect(isCommitShapedBranch('5c156c9')).toBeTrue()
  expect(isCommitShapedBranch('5c156c96b1234567890123456789012345678901')).toBeTrue()
  expect(isCommitShapedBranch('main')).toBeFalse()
  expect(isCommitShapedBranch('DEV-2031-orch-review')).toBeFalse()
  expect(isCommitShapedBranch('worktree-dev-2016-harper-dep')).toBeFalse()
})
