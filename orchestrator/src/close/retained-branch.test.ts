import { expect, test } from 'bun:test'
import { retainedBranchForCloseOut } from './retained-branch.ts'

test('close-out retains a minted branch and no branch for an unminted run', () => {
  expect(retainedBranchForCloseOut('DEV-934-orch-6536')).toBe('DEV-934-orch-6536')
  expect(retainedBranchForCloseOut(null)).toBeNull()
})
