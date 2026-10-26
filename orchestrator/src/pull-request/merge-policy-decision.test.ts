import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { PullRequestCheck } from './merge-decision.ts'
import { decideMergePolicyRefusal } from './merge-policy-decision.ts'

const check = (name: string, bucket: PullRequestCheck['bucket']): PullRequestCheck => ({
  name,
  bucket,
  state: bucket,
  link: `https://checks.example/${name}`,
})

const policyMessage = (shape: string) =>
  `pull-request merge failed: GraphQL: ${shape} (mergePullRequest)`

const input = (
  values: Partial<Parameters<typeof decideMergePolicyRefusal>[0]> = {},
): Parameters<typeof decideMergePolicyRefusal>[0] => ({
  message: policyMessage('Base branch policy prohibits the merge'),
  checks: [check('Check', 'pending'), check('Build demo', 'pending')],
  target: '42',
  number: 42,
  ...values,
})

const waitOrRerun = `wait for pending checks and rerun ${PLATFORM_SLUG} pr merge 42, or fix failing checks with gh pr checks 42`
const otherRequirement =
  "GitHub's branch policy blocks the merge: the block is not a check, but another branch requirement such as a review approval, conversation resolution or a required deployment; " +
  `cleared by: gh pr view 42 to see the unmet requirement, then rerun ${PLATFORM_SLUG} pr merge 42`
const unreadable =
  "GitHub's branch policy blocks the merge: the checks could not be listed and the block may be a check or another requirement; " +
  `cleared by: gh pr checks 42, gh pr view 42, then rerun ${PLATFORM_SLUG} pr merge 42`

describe('GitHub branch-policy merge classification', () => {
  test('classifies gh policy text as a policy refusal', () => {
    expect(decideMergePolicyRefusal(input()).policy).toBe(true)
  })

  test.each([
    ['Required status check "ci" is expected.'],
    ['Required status check "ci" is in progress.'],
    ['Required status check "ci" is failing.'],
  ])('does not classify %s as a policy refusal', (shape) => {
    expect(decideMergePolicyRefusal(input({ message: policyMessage(shape) }))).toEqual({
      policy: false,
    })
  })

  test('names pending, failing and cancelled checks from the rollup', () => {
    expect(
      decideMergePolicyRefusal(
        input({
          checks: [
            check('Check', 'pending'),
            check('Build demo', 'fail'),
            check('lint', 'cancel'),
            check('test', 'pass'),
          ],
        }),
      ),
    ).toEqual({
      policy: true,
      refusal: `GitHub's branch policy blocks the merge: Check pending, Build demo failing, lint cancelled; cleared by: ${waitOrRerun}`,
    })
  })

  test('a cancelled check keeps the wait-or-rerun remedy', () => {
    expect(decideMergePolicyRefusal(input({ checks: [check('lint', 'cancel')] }))).toEqual({
      policy: true,
      refusal: `GitHub's branch policy blocks the merge: lint cancelled; cleared by: ${waitOrRerun}`,
    })
  })

  test('says the checks could not be listed when the rollup is absent', () => {
    expect(decideMergePolicyRefusal(input({ checks: null }))).toEqual({
      policy: true,
      refusal: unreadable,
    })
  })

  test('names another branch requirement when the rollup has no pending, failing or cancelled checks', () => {
    expect(
      decideMergePolicyRefusal(input({ checks: [check('ci', 'pass'), check('lint', 'skipping')] })),
    ).toEqual({
      policy: true,
      refusal: otherRequirement,
    })
  })

  test('an access or API failure stays unclassified even when checks are pending', () => {
    expect(
      decideMergePolicyRefusal(
        input({
          message: 'review store unavailable',
          checks: [check('Check', 'pending')],
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
