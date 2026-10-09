import { expect, test } from 'bun:test'
import {
  retainedBranchForCloseOut,
  retainedBranchPruneCommand,
  retainedBranchReason,
} from './retained-branch.ts'

test('close-out retains a minted branch and no branch for an unminted run', () => {
  expect(retainedBranchForCloseOut('DEV-934-orch-6536')).toBe('DEV-934-orch-6536')
  expect(retainedBranchForCloseOut(null)).toBeNull()
})

test('retained branch presentation names its purpose and scoped cleanup', () => {
  expect(retainedBranchReason('DEV-1199-orch-1')).toBe(
    'DEV-1199-orch-1 is run recovery evidence until task landing is classified',
  )
  expect(retainedBranchPruneCommand('fixture-project', 'DEV-1199')).toBe(
    'orch branches prune --project fixture-project --key DEV-1199',
  )
  expect(retainedBranchPruneCommand('fixture-project', null)).toBeNull()
})
