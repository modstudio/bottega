import { describe, expect, test } from 'bun:test'
import {
  decidePrematureFinal,
  PREMATURE_FINAL_MAX_MS,
  type PrematureFinalFacts,
} from './premature-final.ts'

const diagnosisOpening =
  'Starting DEV-1016 diagnosis: reading the full prompt, task, and outbox contract sources.'
const reviewOpening = 'Review not started; reading the full prompt and checkout first.'

function facts(overrides: Partial<PrematureFinalFacts> = {}): PrematureFinalFacts {
  return {
    exitCode: 0,
    latencyMs: PREMATURE_FINAL_MAX_MS,
    toolEventRecorded: false,
    evidence: {},
    questionsAsked: false,
    replyShape: 'all-blocked-reader',
    textFields: [diagnosisOpening],
    ...overrides,
  }
}

describe('premature final decision', () => {
  test('refuses the opening narration from blocked diagnosis run 7175', () => {
    expect(decidePrematureFinal(facts())).toEqual({
      failureKind: 'unevidenced',
      error:
        'premature final: the agent ended its turn with opening narration and no work ' +
        `(Starting DEV-1016 diagnosis: reading the full prompt, task, and outbox contract …)`,
    })
  })

  test('refuses the opening narration from empty review run 7194', () => {
    expect(
      decidePrematureFinal(facts({ replyShape: 'empty-review', textFields: [reviewOpening] })),
    ).not.toBeNull()
  })

  test.each([
    ['one tool event', { toolEventRecorded: true }],
    ['one file covered', { evidence: { filesCovered: ['orchestrator/src/run/run.ts'] } }],
    ['a question asked', { questionsAsked: true }],
    ['latency above the maximum', { latencyMs: PREMATURE_FINAL_MAX_MS + 1 }],
    ['a substantive blocked reason', { textFields: ['the named branch does not exist'] }],
  ] satisfies [string, Partial<PrematureFinalFacts>][])('allows %s', (_name, overrides) => {
    expect(decidePrematureFinal(facts(overrides))).toBeNull()
  })

  test('refuses a done writer with no changed files', () => {
    expect(
      decidePrematureFinal(
        facts({
          replyShape: 'done-writer-no-files',
          evidence: { filesChanged: [] },
          textFields: ['Before writing the change, I will read the implementation.'],
        }),
      ),
    ).not.toBeNull()
  })
})
