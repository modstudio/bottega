import { describe, expect, test } from 'bun:test'
import type { ChangeFacts, Finding } from '../shared/ratchet'
import { cognitiveComplexityDecision, complexityFindings } from './check-cognitive-ceiling'

const facts = (): ChangeFacts => ({ renames: new Map(), addedLines: new Map() })

function finding(file: string, symbol: string, measure: number, line = 1): Finding {
  return {
    file,
    line,
    rule: 'cognitive-complexity',
    message: `complexity ${measure}, limit 15`,
    symbol,
    measure,
  }
}

describe('cognitive complexity decision', () => {
  test('refuses a function whose score rose and reports its previous score', () => {
    expect(
      cognitiveComplexityDecision({
        base: [finding('complex.ts', 'work', 20)],
        head: [finding('complex.ts', 'work', 21)],
        facts: facts(),
      }),
    ).toEqual([expect.objectContaining({ reason: 'grew', previousMeasure: 20 })])
  })

  test('allows a function whose score fell but remains over the limit', () => {
    expect(
      cognitiveComplexityDecision({
        base: [finding('complex.ts', 'work', 20)],
        head: [finding('complex.ts', 'work', 18)],
        facts: facts(),
      }),
    ).toEqual([])
  })

  test('refuses a new function over the limit', () => {
    expect(
      cognitiveComplexityDecision({
        base: [],
        head: [finding('complex.ts', 'newWork', 16)],
        facts: facts(),
      }),
    ).toEqual([expect.objectContaining({ reason: 'new-measured' })])
  })

  test('allows an untouched over-limit function in an edited file', () => {
    const unchanged = finding('complex.ts', 'work', 20)
    expect(
      cognitiveComplexityDecision({ base: [unchanged], head: [unchanged], facts: facts() }),
    ).toEqual([])
  })

  test('keeps the allowance when a file is renamed', () => {
    const renameFacts = facts()
    renameFacts.renames.set('new.ts', 'old.ts')
    expect(
      cognitiveComplexityDecision({
        base: [finding('old.ts', 'work', 20)],
        head: [finding('new.ts', 'work', 20)],
        facts: renameFacts,
      }),
    ).toEqual([])
  })

  test('an unlintable base refuses only findings on added lines', () => {
    const fallbackFacts = facts()
    fallbackFacts.addedLines.set('complex.ts', [{ start: 5, end: 5 }])
    expect(
      cognitiveComplexityDecision({
        base: [],
        head: [finding('complex.ts', 'added', 20, 5), finding('complex.ts', 'existing', 30, 10)],
        facts: fallbackFacts,
        baseFailures: new Set(['complex.ts']),
      }),
    ).toEqual([expect.objectContaining({ symbol: 'added', reason: 'added-line' })])
  })
})

describe('complexity finding names', () => {
  test('derives declarations, variables, methods, callbacks, and duplicate names from text', () => {
    const text = [
      'function declared() { return 1 }',
      'const assigned = () => 2',
      'const holder = { method() { return 3 } }',
      'items.map(() => true)',
      'const one = function duplicate() { return 1 }',
      'const two = function duplicate() { return 2 }',
    ].join('\n')
    const messages = [1, 2, 3, 4, 5, 6].map((line, index) => ({
      ruleId: 'sonarjs/cognitive-complexity',
      severity: 2,
      line,
      column: [1, 18, 18, 11, 13, 13][index],
      message:
        'Refactor this function to reduce its Cognitive Complexity from 16 to the 15 allowed.',
    }))

    expect(complexityFindings('names.ts', text, messages).map(({ symbol }) => symbol)).toEqual([
      'declared',
      'assigned',
      'method',
      'map callback',
      'duplicate#1',
      'duplicate#2',
    ])
  })
})
