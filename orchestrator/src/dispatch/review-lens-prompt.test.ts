import { describe, expect, test } from 'bun:test'
import { reviewLensPrompt } from './review-lens-prompt.ts'

const lens = { question: 'Does the change actually hold?', excludes: 'taste and style nits' }

describe('reviewLensPrompt', () => {
  test('no-prompt mutation: a lens question is the prompt', () => {
    expect(reviewLensPrompt({ lens, supplied: '' })).toBe(
      `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}`,
    )
  })

  test('supplied-prompt mutation: lens text first, supplied text after', () => {
    const supplied = 'focus on the new parser'
    const prompt = reviewLensPrompt({ lens, supplied })
    expect(prompt.startsWith(`QUESTION\n${lens.question}`)).toBe(true)
    expect(prompt.indexOf(lens.question)).toBeLessThan(prompt.indexOf(supplied))
    expect(prompt.endsWith(supplied)).toBe(true)
    expect(prompt).not.toBe(supplied)
  })

  test('no-lens mutation: review-lens without a lens is still refused as empty', () => {
    expect(() => reviewLensPrompt({ lens: null, supplied: '' })).toThrow('empty prompt')
    expect(() => reviewLensPrompt({ lens: null, supplied: '  \n' })).toThrow('empty prompt')
  })
})
