import { describe, expect, test } from 'bun:test'
import { decideMergeProof, type MergeProofInput, type PullRequestCheck } from './merge-decision.ts'

const passing = (name: string): PullRequestCheck => ({
  name,
  bucket: 'pass',
  state: 'SUCCESS',
  link: `https://checks.example/${name}`,
})

const input = (values: Partial<MergeProofInput> = {}): MergeProofInput => ({
  number: 42,
  state: 'OPEN',
  baseBranch: 'main',
  landingBranch: 'main',
  headCommit: 'head-commit',
  requiredChecks: ['test', 'lint'],
  checks: [passing('test'), passing('lint')],
  passingGateId: null,
  remoteLandingTip: null,
  mergeBase: null,
  ...values,
})

describe('required-check merge proof', () => {
  test('all declared checks passing admits the head', () => {
    expect(decideMergeProof(input())).toEqual({ admitted: true })
  })

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

  test('an undeclared failing check is ignored', () => {
    expect(
      decideMergeProof(
        input({
          checks: [
            passing('test'),
            passing('lint'),
            {
              name: 'optional',
              bucket: 'fail',
              state: 'FAILURE',
              link: 'https://checks.example/optional',
            },
          ],
        }),
      ),
    ).toEqual({ admitted: true })
  })
})

describe('local-gate merge proof', () => {
  const local = (values: Partial<MergeProofInput> = {}) =>
    input({
      requiredChecks: [],
      checks: [],
      passingGateId: 9,
      remoteLandingTip: 'base-commit',
      mergeBase: 'base-commit',
      ...values,
    })

  test('a recorded gate and level landing branch admit the head', () => {
    expect(decideMergeProof(local())).toEqual({ admitted: true })
  })

  test('a missing gate record names the gate command', () => {
    const decision = decideMergeProof(local({ passingGateId: null }))
    expect(decision).toEqual({
      admitted: false,
      refusal: expect.stringContaining('orch gate run'),
    })
  })

  test('a moved landing branch names the update and regate remedy', () => {
    const decision = decideMergeProof(local({ remoteLandingTip: 'new-base' }))
    expect(decision).toEqual({
      admitted: false,
      refusal: expect.stringContaining('bring the branch up to origin/main, run orch gate run'),
    })
  })
})

test('a closed pull request is refused with what was found', () => {
  expect(decideMergeProof(input({ state: 'CLOSED' }))).toEqual({
    admitted: false,
    refusal: expect.stringContaining('is CLOSED, not open'),
  })
})

test('a pull request against the wrong base is refused with what was found', () => {
  expect(decideMergeProof(input({ baseBranch: 'release' }))).toEqual({
    admitted: false,
    refusal: expect.stringContaining('targets release, not the registered landing branch main'),
  })
})
