import { describe, expect, test } from 'bun:test'
import { operatorKnowledgeSection } from './run-pack-prompt.ts'

describe('operator knowledge prompt section', () => {
  test('a canon-only pack yields a prompt containing the canon', () => {
    const section = operatorKnowledgeSection({ markdown: 'CANON-ONLY-CONTENT' })
    expect(section).toContain('WHAT THE OPERATOR WANTS YOU TO KNOW')
    expect(section).toContain('CANON-ONLY-CONTENT')
  })

  test('an empty pack yields no prompt section', () => {
    expect(operatorKnowledgeSection({ markdown: '' })).toBe('')
  })
})
