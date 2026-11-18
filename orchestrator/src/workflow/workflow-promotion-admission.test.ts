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
        operatorName: 'Shmuel Barkin',
      }),
    ).toEqual({
      verdict: 'allow',
      reason: 'restore production immediately',
      author: 'Shmuel Barkin',
    })
  })
})
