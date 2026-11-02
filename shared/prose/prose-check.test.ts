import { describe, expect, test } from 'bun:test'
import type { EngineFinding, EngineResult } from './harper-adapter.ts'
import {
  americanVariant,
  checkProse,
  proseCheckRefusal,
  proseCheckSkipNotice,
} from './prose-check.ts'

const options = { displayName: null, isEnglishWord: () => false }

function engine(...findings: EngineFinding[]): EngineResult {
  return { ran: true, findings }
}

function finding(
  text: string,
  problem: string,
  replacement: string,
  kind: EngineFinding['suggestions'][number]['kind'] = 'replace',
): EngineFinding {
  const start = text.indexOf(problem)
  return {
    rule: 'SpellCheck',
    start,
    end: start + problem.length,
    text: problem,
    message: 'This word was misspelled.',
    suggestions: [{ kind, text: replacement }],
  }
}

describe('combined prose check', () => {
  test('drops an engine finding that overlaps a mask', () => {
    const text = 'Open shared/meida.ts now.'
    expect(checkProse(text, engine(finding(text, 'meida', 'media')), options)).toEqual({
      ran: true,
      findings: [],
    })
  })

  test('applies the first suggestion to the corrected sentence', () => {
    const text = 'We saw the meida here. Next sentence.'
    const check = checkProse(text, engine(finding(text, 'meida', 'media')), options)
    expect(check.findings[0]?.correctedSentence).toBe('We saw the media here.')
  })

  test('applies two suggestions in the same sentence', () => {
    const text = 'The meida was wierd.'
    const check = checkProse(
      text,
      engine(finding(text, 'meida', 'media'), finding(text, 'wierd', 'weird')),
      options,
    )
    expect(check.findings.map(({ correctedSentence }) => correctedSentence)).toEqual([
      'The media was weird.',
      'The media was weird.',
    ])
  })

  test.each([
    ['replace', 'The meida matters.', 'meida', 'media', 'The media matters.'],
    ['remove', 'This very matters.', 'very ', '', 'This matters.'],
    [
      'insert-after',
      'We changed routing, history and billing.',
      'history',
      ',',
      'We changed routing, history, and billing.',
    ],
  ] as const)(
    'applies a %s suggestion to the finding span',
    (kind, text, problem, value, expected) => {
      const check = checkProse(text, engine(finding(text, problem, value, kind)), options)
      expect(check.findings[0]?.suggestion).toBe(
        kind === 'insert-after' ? `${problem}${value}` : value,
      )
      expect(check.findings[0]?.correctedSentence).toBe(expected)
    },
  )

  test('keeps naming findings and reports a skipped engine', () => {
    const check = checkProse(
      'The operator decided.',
      { ran: false, reason: 'WASM unavailable' },
      { displayName: 'Shmuel Barkin', isEnglishWord: () => false },
    )
    expect(check.findings.map(({ rule }) => rule)).toEqual(['Naming'])
    expect(proseCheckSkipNotice(check)).toBe(
      'Spelling and grammar check did not run: WASM unavailable',
    )
  })

  test('refusal names the span, suggestion, and corrected sentence', () => {
    const text = 'We saw the meida here.'
    const refusal = proseCheckRefusal(
      checkProse(text, engine(finding(text, 'meida', 'media')), options),
    )
    expect(refusal).toContain('"meida"')
    expect(refusal).toContain('suggestion: "media"')
    expect(refusal).toContain('corrected sentence: "We saw the media here."')
    expect(refusal).toEndWith('Correct the text and resubmit it.')
  })

  test('advisory suggestions do not rewrite a corrected sentence or cause a refusal', () => {
    const text = 'We worked in in the repository.'
    const repeated = finding(text, 'in in', 'in')
    repeated.rule = 'RepeatedWords'
    const check = checkProse(text, engine(repeated), options)

    expect(check.findings[0]).toMatchObject({ blocking: false, correctedSentence: text })
    expect(proseCheckRefusal(check)).toBeNull()
  })

  test.each([
    ['behaviour', 'behavior'],
    ['behaviours', 'behaviors'],
    ['honoured', 'honored'],
    ['favouring', 'favoring'],
    ['favourite', 'favorite'],
    ['organise', 'organize'],
    ['realisation', 'realization'],
    ['analyse', 'analyze'],
    ['catalogue', 'catalog'],
    ['dialogues', 'dialogs'],
    ['judgement', 'judgment'],
    ['acknowledgements', 'acknowledgments'],
    ['labelled', 'labeled'],
    ['travelling', 'traveling'],
    ['licence', 'license'],
    ['centre', 'center'],
    ['metres', 'meters'],
  ])('maps British %s to American %s', (british, american) => {
    expect(americanVariant(british, (word) => word === american)).toBe(american)
  })

  test.each(['four', 'hour', 'fence', 'tiller', 'centred'])(
    'does not invent an American variant for %s',
    (word) => {
      expect(americanVariant(word, () => false)).toBeNull()
    },
  )
})
