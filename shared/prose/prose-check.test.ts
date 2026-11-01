import { describe, expect, test } from 'bun:test'
import type { EngineFinding, EngineResult } from './harper-adapter.ts'
import { checkProse, proseCheckRefusal, proseCheckSkipNotice } from './prose-check.ts'

function engine(...findings: EngineFinding[]): EngineResult {
  return { ran: true, findings }
}

function finding(text: string, problem: string, replacement: string): EngineFinding {
  const start = text.indexOf(problem)
  return {
    rule: 'SpellCheck',
    start,
    end: start + problem.length,
    text: problem,
    message: 'This word was misspelled.',
    suggestions: [replacement],
  }
}

describe('combined prose check', () => {
  test('drops an engine finding that overlaps a mask', () => {
    const text = 'Open shared/meida.ts now.'
    expect(
      checkProse(text, engine(finding(text, 'meida', 'media')), { displayName: null }),
    ).toEqual({
      ran: true,
      findings: [],
    })
  })

  test('applies the first suggestion to the corrected sentence', () => {
    const text = 'We saw the meida here. Next sentence.'
    const check = checkProse(text, engine(finding(text, 'meida', 'media')), { displayName: null })
    expect(check.findings[0]?.correctedSentence).toBe('We saw the media here.')
  })

  test('applies two suggestions in the same sentence', () => {
    const text = 'The meida was wierd.'
    const check = checkProse(
      text,
      engine(finding(text, 'meida', 'media'), finding(text, 'wierd', 'weird')),
      { displayName: null },
    )
    expect(check.findings.map(({ correctedSentence }) => correctedSentence)).toEqual([
      'The media was weird.',
      'The media was weird.',
    ])
  })

  test('keeps naming findings and reports a skipped engine', () => {
    const check = checkProse(
      'The operator decided.',
      { ran: false, reason: 'WASM unavailable' },
      { displayName: 'Shmuel Barkin' },
    )
    expect(check.findings.map(({ rule }) => rule)).toEqual(['Naming'])
    expect(proseCheckSkipNotice(check)).toBe(
      'Spelling and grammar check did not run: WASM unavailable',
    )
  })

  test('refusal names the span, suggestion, and corrected sentence', () => {
    const text = 'We saw the meida here.'
    const refusal = proseCheckRefusal(
      checkProse(text, engine(finding(text, 'meida', 'media')), { displayName: null }),
    )
    expect(refusal).toContain('"meida"')
    expect(refusal).toContain('suggestion: "media"')
    expect(refusal).toContain('corrected sentence: "We saw the media here."')
    expect(refusal).toEndWith('Correct the text and resubmit it.')
  })
})
