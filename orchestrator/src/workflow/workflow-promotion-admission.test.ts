import { describe, expect, test } from 'bun:test'
import { decideWorkflowPromotionAdmission } from './workflow-promotion-admission.ts'

describe('workflow promotion admission', () => {
  test('allows a checkout whose HEAD is on the landing branch', () => {
    expect(
      decideWorkflowPromotionAdmission({
        landingBranch: 'main',
        landingBranchContainsHead: true,
        fromOperator: false,
        reason: 'landed workflow',
        author: 'session',
      }),
    ).toEqual({ verdict: 'allow', reason: 'landed workflow', author: 'session' })
  })

  test('refuses an unlanded checkout with both remedies', () => {
    const decision = decideWorkflowPromotionAdmission({
      landingBranch: 'main',
      landingBranchContainsHead: false,
      fromOperator: false,
    })
    expect(decision.verdict).toBe('refuse')
    if (decision.verdict === 'refuse') {
      expect(decision.message).toContain("main does not contain the checkout's HEAD")
      expect(decision.message).toContain('land the workflow change by pull request')
      expect(decision.message).toContain('--from-operator')
    }
  })

  test('records the operator as author when the override is present', () => {
    expect(
      decideWorkflowPromotionAdmission({
        landingBranch: 'main',
        landingBranchContainsHead: false,
        fromOperator: true,
        reason: 'restore production immediately',
        author: 'ignored',
        operatorName: 'Dana Example',
      }),
    ).toEqual({
      verdict: 'allow',
      reason: 'override by Dana Example: restore production immediately',
      author: 'Dana Example',
    })
  })

  test('refuses an operator override without a reason', () => {
    expect(
      decideWorkflowPromotionAdmission({
        landingBranch: 'main',
        landingBranchContainsHead: false,
        fromOperator: true,
        reason: '   ',
        operatorName: 'Dana Example',
      }),
    ).toEqual({
      verdict: 'refuse',
      message:
        'workflow promotion --from-operator requires a non-empty reason; rerun with --reason "<reason>" --from-operator',
    })
  })

  test("refuses an override without the overriding user's identity", () => {
    expect(
      decideWorkflowPromotionAdmission({
        landingBranch: 'main',
        landingBranchContainsHead: false,
        fromOperator: true,
        reason: 'restore production immediately',
        operatorName: null,
      }),
    ).toEqual({
      verdict: 'refuse',
      message: "workflow promotion --from-operator requires the overriding user's identity",
    })
  })
})
