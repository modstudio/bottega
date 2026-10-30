import { describe, expect, test } from 'bun:test'
import {
  applyPrematureFinalFailure,
  decidePrematureFinal,
  type PrematureFinalFacts,
} from './premature-final.ts'

const readerOpening =
  "I'll start by reading the full prompt, the review schema, and the MCP tool definitions."
const reviewOpening =
  'Reading the full review prompt and gathering the artifact, task, and gate sources.'

function facts(overrides: Partial<PrematureFinalFacts> = {}): PrematureFinalFacts {
  return {
    exitCode: 0,
    toolEventRecorded: false,
    evidence: {},
    reportsRun: false,
    questionsAsked: false,
    replyShape: 'reader',
    deliveredContents: [],
    measuredFiles: null,
    textFields: [readerOpening],
    ...overrides,
  }
}

describe('premature final decision', () => {
  test('classifies understand run 16728 with no deliverables or files written', () => {
    expect(decidePrematureFinal(facts())).toEqual({
      failureKind: 'premature-final',
      error:
        'premature final: the agent ended its turn with opening narration and no work ' +
        `(I'll start by reading the full prompt, the review schema, and the MCP tool definitions.…)`,
    })
  })

  test('classifies a reader reply whose delivered content is only opening narration', () => {
    const opening =
      'Starting diagnosis of DEV-1878: reading the full prompt, task, reply schema, and gate result.'
    expect(
      decidePrematureFinal(facts({ deliveredContents: [opening], textFields: [opening] })),
    ).not.toBeNull()
  })

  test('allows a reader reply with opening narration when a tool event was recorded', () => {
    const opening =
      'Starting diagnosis of DEV-1878: reading the full prompt, task, reply schema, and gate result.'
    expect(
      decidePrematureFinal(
        facts({
          deliveredContents: [opening],
          textFields: [opening],
          toolEventRecorded: true,
        }),
      ),
    ).toBeNull()
  })

  test('allows a reader reply with opening narration and a substantive deliverable', () => {
    const opening =
      'Starting diagnosis of DEV-1878: reading the full prompt, task, reply schema, and gate result.'
    expect(
      decidePrematureFinal(
        facts({
          deliveredContents: [opening, 'The gate failed because the reply omitted its findings.'],
          textFields: [opening, 'The gate failed because the reply omitted its findings.'],
        }),
      ),
    ).toBeNull()
  })

  test('classifies review-lens run 16613 with a placeholder finding and no provenance', () => {
    expect(
      decidePrematureFinal(facts({ replyShape: 'review', textFields: [reviewOpening] })),
    ).not.toBeNull()
  })

  test.each([
    ['one tool event', { toolEventRecorded: true }],
    ['one file covered', { evidence: { filesCovered: ['orchestrator/src/run/run.ts'] } }],
    ['a question asked', { questionsAsked: true }],
    ['a reported test run', { reportsRun: true }],
    ['a substantive blocked reason', { textFields: ['the named branch does not exist'] }],
  ] satisfies [string, Partial<PrematureFinalFacts>][])('allows %s', (_name, overrides) => {
    expect(decidePrematureFinal(facts(overrides))).toBeNull()
  })

  test('classifies implement run 16752 with no changed files or tests run', () => {
    expect(
      decidePrematureFinal(
        facts({
          replyShape: 'done-writer',
          evidence: { filesChanged: [] },
          measuredFiles: [],
          textFields: ['Before writing the change, I will read the implementation.'],
        }),
      ),
    ).not.toBeNull()
  })

  test('a real reply that changed a file does not classify', () => {
    expect(
      decidePrematureFinal(
        facts({
          replyShape: 'done-writer',
          evidence: { filesChanged: ['orchestrator/src/run/run.ts'] },
          measuredFiles: ['orchestrator/src/run/run.ts'],
          textFields: ['Before writing the change, I will read the implementation.'],
        }),
      ),
    ).toBeNull()
  })

  test('a lens with evidence does not classify', () => {
    expect(
      decidePrematureFinal(
        facts({
          replyShape: 'review',
          evidence: { filesCovered: ['orchestrator/src/run/run.ts'] },
          textFields: [reviewOpening],
        }),
      ),
    ).toBeNull()
  })

  test.each([
    ['ok', { status: 'ok' as const, failureKind: null, error: null }],
    [
      'unevidenced',
      { status: 'failed' as const, failureKind: 'unevidenced', error: 'no review evidence' },
    ],
    ['other', { status: 'failed' as const, failureKind: 'other', error: 'no writer changes' }],
  ])('replaces a provisional %s outcome', (_name, outcome) => {
    const refusal = decidePrematureFinal(facts())
    expect(applyPrematureFinalFailure(outcome, refusal)).toMatchObject({
      status: 'failed',
      failureKind: 'premature-final',
    })
  })

  test('preserves a prior substantive failure', () => {
    const truncated = {
      status: 'failed' as const,
      failureKind: 'truncated',
      error: 'vendor terminated stream',
    }
    expect(applyPrematureFinalFailure(truncated, decidePrematureFinal(facts()))).toEqual(truncated)
  })
})
