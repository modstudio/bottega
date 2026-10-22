import { describe, expect, test } from 'bun:test'
import { continuationProvisioningDecision } from './continuation-provision-decision.ts'

const recorded = { seed: 'minimal', refusal: null }
const missingRequired = {
  seed: undefined,
  refusal:
    'this project requires a database size for a new worktree, and has no default.\n' +
    '  --seed minimal',
}
const defaulted = { seed: 'small', refusal: null }
const optional = { seed: undefined, refusal: null }

describe('continuation provisioning decision', () => {
  test.each([
    [
      'a reused intact tree needs none',
      { reuseIntactTree: true, seed: recorded },
      { action: 'none' },
    ],
    [
      'a reused intact tree needs none even when the recorded seed is missing',
      { reuseIntactTree: true, seed: missingRequired },
      { action: 'none' },
    ],
    [
      'a recreated tree needs the recipe with the recorded seed',
      { reuseIntactTree: false, seed: recorded },
      { action: 'provision', seed: 'minimal' },
    ],
    [
      'a recreated tree uses the project default when no seed was recorded',
      { reuseIntactTree: false, seed: defaulted },
      { action: 'provision', seed: 'small' },
    ],
    [
      'a recreated tree with no seed requirement provisions without one',
      { reuseIntactTree: false, seed: optional },
      { action: 'provision', seed: undefined },
    ],
    [
      'a missing recorded seed where the project requires one refuses',
      { reuseIntactTree: false, seed: missingRequired },
      { action: 'refuse', reason: 'missing-recorded-seed' },
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(continuationProvisioningDecision(input)).toEqual(expected)
  })
})
