import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideMachineUpdateRecovery } from './machine-update-recovery.ts'

const swapped = { kind: 'checkout' as const, target: '/main', priorCommit: 'before' }
const before = { orchestrator: 10, hub: 20 }

test('unchanged positions restore the prior state', () => {
  expect(decideMachineUpdateRecovery({ before, after: before, swapped }).action).toBe('restore')
})

test('a moved position keeps the new state and names the rerun', () => {
  expect(decideMachineUpdateRecovery({ before, after: { ...before, hub: 21 }, swapped })).toEqual({
    action: 'keep',
    message: `the new state was kept because a store journal position moved; rerun ${PLATFORM_SLUG} machine update`,
  })
})

test('a failed restore names the manual remedy', () => {
  expect(decideMachineUpdateRecovery({ before, swapped, restoreFailure: 'denied' })).toEqual({
    action: 'manual',
    message: `restoring main to before failed: denied; manually run git -C /main reset --keep before, then ${PLATFORM_SLUG} machine update`,
  })
})

test('unreadable positions leave the new state and name the manual remedy', () => {
  expect(decideMachineUpdateRecovery({ before, after: null, swapped })).toEqual({
    action: 'manual',
    message: `the store journal positions could not be read; leave the new state in place and rerun ${PLATFORM_SLUG} machine update`,
  })
})
