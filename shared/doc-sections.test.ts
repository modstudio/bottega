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
    ['unclosed section', ':::section{audience="technical"}\nText', 'not closed'],
  ])('refuses %s', (_name, body, message) => {
    expect(docSectionRefusal(body, [...audiences])).toContain(message)
  })

  test('a body without marks is accepted', () => {
    expect(docSectionRefusal('## Ordinary\n\nText', [...audiences])).toBeNull()
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
    const body = '```md\n:::section{audience="internal"}\nsecret\n:::\n```'
    expect(docSections(body)).toEqual([])
    expect(docBodyForAudience(body, 'technical')).toBe(body)
  })
})
