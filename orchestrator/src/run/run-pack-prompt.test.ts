import { describe, expect, test } from 'bun:test'
import {
  bindReviewInstructions,
  checksReviewedCommit,
  initialDispatchPrompt,
  operatorKnowledgeSection,
} from './run-pack-prompt.ts'

describe('operator knowledge prompt section', () => {
  test('a canon-only pack yields a prompt containing the canon', () => {
    const section = operatorKnowledgeSection({ markdown: 'CANON-ONLY-CONTENT' })
    expect(section).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
    expect(section).toContain('CANON-ONLY-CONTENT')
  })

  test('an empty pack yields no prompt section', () => {
    expect(operatorKnowledgeSection({ markdown: '' })).toBe('')
  })

  test('places task rulings after operator knowledge and before the spec', () => {
    const prompt = initialDispatchPrompt({
      writesJob: true,
      preamble: 'PREAMBLE',
      infrastructure: '',
      operatorKnowledge: 'WHAT THE OPERATOR WANTS YOU TO KNOW\n\nCANON',
      taskRulings: 'RULINGS ALREADY MADE ON THIS TASK\n\nRULING',
      spec: 'WORK',
    })
    expect(prompt.indexOf('CANON')).toBeLessThan(prompt.indexOf('RULINGS ALREADY'))
    expect(prompt.indexOf('RULINGS ALREADY')).toBeLessThan(prompt.indexOf('THE SPEC'))
  })
})

describe('review instructions', () => {
  test('checks repository-backed findings but not inline findings', () => {
    expect(checksReviewedCommit(true, true)).toBe(true)
    expect(checksReviewedCommit(true, false)).toBe(false)
  })

  test('binds an implicit repository review artifact without a branch', () => {
    const prompt = bindReviewInstructions({
      prompt: 'Review this change.',
      findings: true,
      firstTurn: true,
      reviewTarget: null,
      readsRepo: true,
      checkoutCommit: 'caf69b0d11111111111111111111111111111111',
      coverageBase: 'b0583f6522222222222222222222222222222222',
      lens: undefined,
      repo: null,
    })

    expect(prompt).toContain('REVIEW ARTIFACT')
    expect(prompt).toContain('HEAD: caf69b0d11111111111111111111111111111111')
    expect(prompt).toContain('Base: b0583f6522222222222222222222222222222222')
    expect(prompt).not.toContain('Branch:')
  })
})
