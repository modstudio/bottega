import { describe, expect, test } from 'bun:test'
import { DOC_SUMMARY_MAX_LENGTH, docSummary, normalizeDocAudiences } from './docs.ts'

describe('normalizeDocAudiences', () => {
  test('refuses empty, duplicate, and unknown sets and orders valid input', () => {
    expect(() => normalizeDocAudiences([])).toThrow('must not be empty')
    expect(() => normalizeDocAudiences(['user', 'user'])).toThrow('duplicate')
    expect(() => normalizeDocAudiences(['other'])).toThrow('unknown')
    expect(normalizeDocAudiences(['technical', 'user'])).toEqual(['user', 'technical'])
  })
})

describe('docSummary', () => {
  test('skips front matter and a leading heading', () => {
    expect(docSummary('---\nstatus: open\n---\n# Install\n\nThe first paragraph.')).toBe(
      'The first paragraph.',
    )
  })
  test('does not take lists or code fences as prose', () => {
    expect(docSummary('- item\n\n```ts\nconst x = 1\n```\n\nUseful prose.')).toBe('Useful prose.')
  })
  test('strips inline markdown', () => {
    expect(docSummary('Use **strong**, `code`, and [the guide](/docs).')).toBe(
      'Use strong, code, and the guide.',
    )
  })
  test('truncates at a word boundary', () => {
    const text = `${'word '.repeat(40)}finish`
    const summary = docSummary(text)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(DOC_SUMMARY_MAX_LENGTH + 1)
    expect(summary.slice(0, -1).endsWith(' ')).toBe(false)
  })
  test('is empty without prose', () => expect(docSummary('# Heading\n\n- item\n')).toBe(''))
})
