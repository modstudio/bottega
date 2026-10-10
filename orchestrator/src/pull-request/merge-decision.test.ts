import { describe, expect, test } from 'bun:test'
import {
  decideMergeProof,
  decidePullRequestIdentity,
  type MergeProofInput,
  type PullRequestCheck,
} from './merge-decision.ts'

const passing = (name: string): PullRequestCheck => ({
  name,
  bucket: 'pass',
  state: 'SUCCESS',
  link: `https://checks.example/${name}`,
})

type RequiredChecksInput = Extract<MergeProofInput, { kind: 'required-checks' }>

const input = (values: Partial<RequiredChecksInput> = {}): RequiredChecksInput => ({
  kind: 'required-checks',
  number: 42,
  headCommit: 'head-commit',
  currentHeadCommit: 'head-commit',
  requiredChecks: ['test', 'lint'],
  checks: [passing('test'), passing('lint')],
  ...values,
})

describe('required-check merge proof', () => {
  test.each([
    ['pending', { name: 'lint', bucket: 'pending', state: 'IN_PROGRESS' }],
    ['cancelled', { name: 'lint', bucket: 'cancel', state: 'CANCELLED' }],
  ] as const)('a %s required check is named with its state and link', (_label, check) => {
    const decision = decideMergeProof(
      input({
        checks: [
          passing('test'),
          { ...check, link: 'https://checks.example/lint' } as PullRequestCheck,
        ],
      }),
    )
    expect(decision).toEqual({
      admitted: false,
      refusal: expect.stringContaining(`lint: ${check.state} (https://checks.example/lint)`),
    })
  })

  test('a missing required check is named', () => {
    expect(decideMergeProof(input({ checks: [passing('test')] }))).toEqual({
      admitted: false,
      refusal: expect.stringContaining('lint: missing'),
    })
  })

  test('a required name with one passing and one failing check is refused', () => {
    const decision = decideMergeProof(
      input({
        requiredChecks: ['test'],
        checks: [
          passing('test'),
          {
            name: 'test',
            bucket: 'fail',
            state: 'FAILURE',
            link: 'https://checks.example/test-failure',
          },
        ],
      }),
    )
    expect(decision).toEqual({
      admitted: false,
      refusal: expect.stringContaining('test: FAILURE (https://checks.example/test-failure)'),
    })
  })
})

describe('local-gate merge proof', () => {
  type LocalGateInput = Extract<MergeProofInput, { kind: 'local-gate' }>
  const local = (values: Partial<LocalGateInput> = {}): LocalGateInput => ({
    kind: 'local-gate',
    number: 42,
    headCommit: 'head-commit',
    currentHeadCommit: 'head-commit',
    landingBranch: 'main',
    gate: {
      recorded: true,
      remoteLandingTip: 'base-commit',
      mergeBase: 'base-commit',
    },
    ...values,
  })

  test('a missing gate record names the gate command', () => {
    const decision = decideMergeProof(local({ gate: { recorded: false } }))
    expect(decision).toEqual({
      admitted: false,
      refusal: expect.stringContaining('orch gate run'),
    })
  })

  test('a moved landing branch names the update and regate remedy', () => {
    const decision = decideMergeProof(
      local({
        gate: {
          recorded: true,
          remoteLandingTip: 'new-base',
          mergeBase: 'base-commit',
        },
      }),
    )
    expect(decision).toEqual({
      admitted: false,
      refusal: expect.stringContaining('bring the branch up to origin/main, run orch gate run'),
    })
  })
})

test('a pull request against the wrong base is refused with what was found', () => {
  expect(
    decidePullRequestIdentity({
      number: 42,
      state: 'OPEN',
      baseBranch: 'release',
      landingBranch: 'main',
    }),
  ).toEqual({
    admitted: false,
    refusal: expect.stringContaining('targets release, not the registered landing branch main'),
  })
})
