import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideMergePolicyRefusal, type MergePolicyCheck } from './merge-policy-decision.ts'

const pending = (name: string): MergePolicyCheck => ({ name, bucket: 'pending' })
const failing = (name: string): MergePolicyCheck => ({ name, bucket: 'fail' })
const passing = (name: string): MergePolicyCheck => ({ name, bucket: 'pass' })

const policyMessage = (shape: string) =>
  `pull-request merge failed: GraphQL: ${shape} (mergePullRequest)`

const input = (
  values: Partial<Parameters<typeof decideMergePolicyRefusal>[0]> = {},
): Parameters<typeof decideMergePolicyRefusal>[0] => ({
  message: policyMessage('Base branch policy prohibits the merge'),
  checks: [pending('Check'), pending('Build demo')],
  target: '42',
  number: 42,
  ...values,
})

const waitOrRerun = `wait for pending checks and rerun ${PLATFORM_SLUG} pr merge 42, or fix failing checks with gh pr checks 42`

describe('GitHub branch-policy merge classification', () => {
  test.each([
    ['base branch policy prohibits the merge'],
    ['Required status check "ci" is expected.'],
    ['Required status check "ci" is in progress.'],
    ['Required status check "ci" is failing.'],
  ])('classifies %s as a policy refusal', (shape) => {
    expect(decideMergePolicyRefusal(input({ message: policyMessage(shape) })).policy).toBe(true)
  })

  test('names pending and failing checks from the rollup', () => {
    expect(
      decideMergePolicyRefusal(
        input({
          checks: [pending('Check'), failing('Build demo'), passing('test')],
        }),
      ),
    ).toEqual({
      policy: true,
      refusal: `GitHub's branch policy blocks the merge: Check pending, Build demo failing; cleared by: ${waitOrRerun}`,
    })
  })

  test('says the checks could not be listed when the rollup is absent', () => {
    expect(decideMergePolicyRefusal(input({ checks: null }))).toEqual({
      policy: true,
      refusal: `GitHub's branch policy blocks the merge: the checks could not be listed; cleared by: ${waitOrRerun}`,
    })
  })

  test('keeps the wait-or-rerun remedy when the rollup has no pending or failing checks', () => {
    expect(decideMergePolicyRefusal(input({ checks: [passing('ci')] }))).toEqual({
      policy: true,
      refusal: `GitHub's branch policy blocks the merge; cleared by: ${waitOrRerun}`,
    })
  })

  test('an access or API failure stays unclassified even when checks are pending', () => {
    expect(
      decideMergePolicyRefusal(
        input({
          message: 'review store unavailable',
          checks: [pending('Check')],
        }),
      ),
    ).toEqual({ policy: false })
  })

  test('an auto-merge enqueue refusal is not a branch-policy block', () => {
    expect(
      decideMergePolicyRefusal(
        input({
          message: 'Auto merge is not allowed for this repository (enablePullRequestAutoMerge)',
        }),
      ),
    ).toEqual({ policy: false })
  })
})
