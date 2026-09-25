import { expect, test } from 'bun:test'
import { branchDeletableBy } from './branch-deletion-provenance.ts'

test('only a branch minted by the run conversation is deletable', () => {
  expect(branchDeletableBy('DEV-934-orch-6536', ['DEV-934-orch-6536'])).toBe(true)
  expect(branchDeletableBy('DEV-930-orch-6210', [null])).toBe(false)
  expect(branchDeletableBy('DEV-930-orch-6210', ['DEV-934-orch-6536'])).toBe(false)
  expect(branchDeletableBy(null, ['DEV-934-orch-6536'])).toBe(false)
})
