import { describe, expect, test } from 'bun:test'
import {
  decideReviewOwedCheckout,
  type ReviewOwedCheckoutFacts,
} from './workflow-review-owed-checkout.ts'

const projectPath = '/projects/main'

const facts = (overrides: Partial<ReviewOwedCheckoutFacts> = {}): ReviewOwedCheckoutFacts => ({
  worktreeArg: null,
  worktreeExists: false,
  worktreeHead: null,
  branchArg: null,
  projectPath,
  ...overrides,
})

describe('review-owed checkout selection', () => {
  test('falls back from an absent stored worktree to the branch in the project checkout', () => {
    expect(
      decideReviewOwedCheckout(
        facts({
          worktreeArg: '/absent/DEV-1015',
          branchArg: 'DEV-1015-orch-8460',
        }),
      ),
    ).toEqual({ cwd: projectPath, branch: 'DEV-1015-orch-8460' })
  })

  test('a live worktree branch wins over a differing branch argument', () => {
    expect(
      decideReviewOwedCheckout(
        facts({
          worktreeArg: '/trees/live',
          worktreeExists: true,
          worktreeHead: 'DEV-2406-live',
          branchArg: 'DEV-2406-other',
        }),
      ),
    ).toEqual({ cwd: '/trees/live', branch: 'DEV-2406-live' })
  })

  test.each([null, 'HEAD'])(
    'a live worktree with unresolved HEAD uses the branch argument (%s)',
    (head) => {
      expect(
        decideReviewOwedCheckout(
          facts({
            worktreeArg: '/trees/live',
            worktreeExists: true,
            worktreeHead: head,
            branchArg: 'DEV-2406-arg',
          }),
        ),
      ).toEqual({ cwd: '/trees/live', branch: 'DEV-2406-arg' })
    },
  )

  test('names an absent worktree in its refusal', () => {
    expect(decideReviewOwedCheckout(facts({ worktreeArg: '/trees/gone' }))).toEqual({
      refusal:
        'floor review-owed cannot resolve the cursor branch; /trees/gone is absent; pass `--arg branch=<branch>`, or `--arg worktree=<path of a live checkout>`',
    })
  })

  test('every refusal remedy resolves the checkout', () => {
    const refusalFacts = [
      facts(),
      facts({ worktreeArg: '/trees/gone' }),
      facts({
        worktreeArg: '/trees/live',
        worktreeExists: true,
        worktreeHead: null,
      }),
      facts({
        worktreeArg: '/trees/detached',
        worktreeExists: true,
        worktreeHead: 'HEAD',
      }),
    ]

    for (const input of refusalFacts) {
      const refusal = decideReviewOwedCheckout(input)
      expect(refusal).toHaveProperty('refusal')
      if (!('refusal' in refusal)) continue
      expect(refusal.refusal).toContain('`--arg branch=<branch>`')
      expect(refusal.refusal).toContain('`--arg worktree=<path of a live checkout>`')

      expect(
        decideReviewOwedCheckout({ ...input, branchArg: 'DEV-2406-remedy' }),
      ).not.toHaveProperty('refusal')
      expect(
        decideReviewOwedCheckout({
          ...input,
          worktreeArg: '/trees/remedy',
          worktreeExists: true,
          worktreeHead: 'DEV-2406-remedy',
        }),
      ).not.toHaveProperty('refusal')
    }
  })
})
