import { describe, expect, test } from 'bun:test'
import { reviewLensPrompt } from './review-lens-prompt.ts'

const lens = { question: 'Does the change actually hold?', excludes: 'taste and style nits' }

describe('reviewLensPrompt', () => {
  test('no-prompt mutation: a lens question is the prompt', () => {
    expect(reviewLensPrompt({ lens, mechanicallyEnforced: [], supplied: '' })).toBe(
      `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}`,
    )
  })

  test('supplied-prompt mutation: lens text first, supplied text after', () => {
    const supplied = 'focus on the new parser'
    const prompt = reviewLensPrompt({ lens, mechanicallyEnforced: [], supplied })
    expect(prompt.startsWith(`QUESTION\n${lens.question}`)).toBe(true)
    expect(prompt.indexOf(lens.question)).toBeLessThan(prompt.indexOf(supplied))
    expect(prompt.endsWith(supplied)).toBe(true)
    expect(prompt).not.toBe(supplied)
  })

  test('no-lens mutation: review-lens without a lens is still refused as empty', () => {
    expect(() => reviewLensPrompt({ lens: null, mechanicallyEnforced: [], supplied: '' })).toThrow(
      'empty prompt',
    )
    expect(() =>
      reviewLensPrompt({ lens: null, mechanicallyEnforced: [], supplied: '  \n' }),
    ).toThrow('empty prompt')
  })

  test('renders enforced categories between exclusions and supplied text', () => {
    const supplied = 'focus on the new parser'
    const prompt = reviewLensPrompt({
      lens,
      mechanicallyEnforced: [
        { title: 'Formatting', tool: 'biome format' },
        { title: 'Secrets', tool: 'gitleaks' },
      ],
      supplied,
    })

    expect(prompt).toBe(
      `QUESTION\n${lens.question}\n\nEXCLUDES\n${lens.excludes}\n\n` +
        'ENFORCED BY TOOL IN THIS PROJECT\n' +
        'Formatting: biome format\n' +
        'Secrets: gitleaks\n\n' +
        'A blocking tool refuses these before a change can land here. Do not report a finding whose whole substance is one of them. A defect in the same area that the tool cannot judge is still yours to report.\n\n' +
        supplied,
    )
  })
})
