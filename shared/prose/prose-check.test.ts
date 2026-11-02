import { describe, expect, test } from 'bun:test'
import { checkProse, proseCheckRefusal } from './prose-check.ts'

function options(
  overrides: {
    allowed?: string[]
    misspellings?: Record<string, string>
    british?: Record<string, string>
    displayName?: string | null
  } = {},
) {
  const allowed = new Set(overrides.allowed ?? [])
  return {
    displayName: overrides.displayName ?? null,
    isAllowedWord: (word: string) => allowed.has(word),
    misspellingCorrection: (word: string) => overrides.misspellings?.[word] ?? null,
    americanSpelling: (word: string) => overrides.british?.[word] ?? null,
  }
}

describe('combined prose check', () => {
  test('drops a correction that overlaps a mask', () => {
    const text = 'Open `meida` now.'
    expect(checkProse(text, options({ misspellings: { meida: 'media' } }))).toEqual({
      findings: [],
    })
  })

  test('applies two corrections in the same sentence', () => {
    const text = 'The meida was wierd.'
    const check = checkProse(text, options({ misspellings: { meida: 'media', wierd: 'weird' } }))
    expect(check.findings.map(({ correctedSentence }) => correctedSentence)).toEqual([
      'The media was weird.',
      'The media was weird.',
    ])
  })

  test('classifies misspellings before British spellings', () => {
    const check = checkProse(
      'colour',
      options({ misspellings: { colour: 'collar' }, british: { colour: 'color' } }),
    )
    expect(check.findings[0]).toMatchObject({ rule: 'Misspelling', suggestion: 'collar' })
  })

  test('lets the allow list override both correction lists', () => {
    expect(
      checkProse('analyse', options({ allowed: ['analyse'], british: { analyse: 'analyze' } }))
        .findings,
    ).toEqual([])
  })

  test('keeps naming findings blocking', () => {
    const check = checkProse('The operator decided.', options({ displayName: 'Shmuel Barkin' }))
    expect(check.findings).toHaveLength(1)
    expect(check.findings[0]).toMatchObject({ rule: 'Naming', blocking: true })
  })

  test('refusal names the span, suggestion, and corrected sentence', () => {
    const refusal = proseCheckRefusal(
      checkProse('We saw the meida here.', options({ misspellings: { meida: 'media' } })),
    )
    expect(refusal).toContain('"meida"')
    expect(refusal).toContain('suggestion: "media"')
    expect(refusal).toContain('corrected sentence: "We saw the media here."')
    expect(refusal).toEndWith('Correct the text and resubmit it.')
  })

  test('repeated words are advisory and do not rewrite the corrected sentence', () => {
    const text = 'We worked in in the repository.'
    const check = checkProse(text, options())
    expect(check.findings[0]).toMatchObject({
      rule: 'RepeatedWord',
      suggestion: 'in',
      blocking: false,
      correctedSentence: text,
    })
    expect(proseCheckRefusal(check)).toBeNull()
  })

  test('drops a repeated-word finding that overlaps a mask', () => {
    expect(checkProse('Use `in in` here.', options()).findings).toEqual([])
  })
})
