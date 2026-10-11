import { describe, expect, test } from 'bun:test'
import { docBodyForAudience, docSectionRefusal, docSections } from './doc-sections.ts'

const audiences = ['technical', 'internal'] as const

describe('document sections', () => {
  test.each([
    ['unknown audience', ':::section{audience="partner"}\nText\n:::', 'unknown audience'],
    ['audience not on document', ':::section{audience="customer"}\nText\n:::', 'does not list'],
    ['no audience', ':::section\nText\n:::', 'names no audience'],
    [
      'extra attribute',
      ':::section{audience="technical" tone="quiet"}\nText\n:::',
      'other than audience',
    ],
    [
      'nested section',
      ':::section{audience="technical"}\n:::section{audience="technical"}\nText\n:::\n:::',
      'nested',
    ],
    ['unclosed section', ':::section{audience="internal"}\n', 'not closed'],
    [
      'unclosed section before trailing blank lines',
      'A\n:::section{audience="internal"}\nSecret\n\n\n',
      'not closed',
    ],
    [
      'unclosed section with a blank line in its body',
      'A\n:::section{audience="internal"}\nSecret\n\nMore secret\n',
      'not closed',
    ],
    ['spaced section mark', 'A\n::: section{audience="internal"}\nSecret\n:::\nB', 'line 2'],
    ['capitalized section mark', 'A\n:::Section{audience="internal"}\nSecret\n:::\nB', 'line 2'],
    ['leaf section mark', 'A\n::section{audience="internal"}\nB', 'line 2'],
  ])('refuses %s', (_name, body, message) => {
    expect(docSectionRefusal(body, [...audiences])).toContain(message)
  })

  test('projects the body for one audience and accepts comma-separated audiences', () => {
    const body = [
      'Everyone.',
      ':::section{audience="technical, internal"}',
      'Both.',
      ':::',
      ':::section{audience="internal"}',
      'Internal only.',
      ':::',
      'After.',
    ].join('\n')
    expect(docBodyForAudience(body, 'technical')).toBe('Everyone.\nBoth.\nAfter.')
    expect(docBodyForAudience(body, 'internal')).toBe('Everyone.\nBoth.\nInternal only.\nAfter.')
  })

  test('a directive-looking fence inside code is text, not a mark', () => {
    const body = '```md\n::: section{audience="internal"}\nsecret\n:::\n```'
    expect(docSections(body)).toEqual([])
    expect(docSectionRefusal(body, [...audiences])).toBeNull()
    expect(docBodyForAudience(body, 'technical')).toBe(body)
  })
})
