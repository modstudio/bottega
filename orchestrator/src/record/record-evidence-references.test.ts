import { expect, test } from 'bun:test'
import { evidenceReferences } from './record-evidence-references.ts'

test('hosted evidence references describe the complete kind and payload parent graph', () => {
  expect(evidenceReferences('run', { retryOf: 'retry', parentRunId: 'parent' })).toEqual([
    { table: 'run', id: 'retry', kind: 'retry run' },
    { table: 'run', id: 'parent', kind: 'parent run' },
  ])
  expect(evidenceReferences('score', { id: 'scored' })).toEqual([
    { table: 'run', id: 'scored', kind: 'scored run' },
  ])
  expect(evidenceReferences('question', { runId: 'question-run' })).toEqual([
    { table: 'run', id: 'question-run', kind: 'question run' },
  ])
  expect(evidenceReferences('review_lens', { reviewId: 'review', runId: 'lens-run' })).toEqual([
    { table: 'review', id: 'review', kind: 'lens review' },
    { table: 'run', id: 'lens-run', kind: 'lens run' },
  ])
  expect(
    evidenceReferences('review_finding', {
      reviewId: 'finding-review',
      reviewLensId: 'finding-lens',
    }),
  ).toEqual([
    { table: 'review', id: 'finding-review', kind: 'finding review' },
    { table: 'review_lens', id: 'finding-lens', kind: 'finding lens' },
  ])
  expect(evidenceReferences('landing', { causingLandingId: 'causing' })).toEqual([
    { table: 'landing', id: 'causing', kind: 'causing landing' },
  ])
  expect(evidenceReferences('landing_review_carry', { reviewId: 'carried' })).toEqual([
    { table: 'review', id: 'carried', kind: 'carried review' },
  ])
  expect(
    evidenceReferences('landing_triage_snapshot', {
      readId: 'read',
      overrideId: 'override',
      reviewIds: ['not-a-hosted-record-id'],
    }),
  ).toEqual([
    { table: 'review', id: 'not-a-hosted-record-id', kind: 'triage review' },
    { table: 'review_read', id: 'read', kind: 'triage read' },
    { table: 'landing_override', id: 'override', kind: 'triage override' },
  ])
  expect(evidenceReferences('contention', { runId: 'run', landingId: 'landing' })).toEqual([
    { table: 'run', id: 'run', kind: 'contended run' },
    { table: 'landing', id: 'landing', kind: 'contended landing' },
  ])
})

test('hosted evidence references omit absent and empty parents', () => {
  expect(evidenceReferences('landing_triage_snapshot', { readId: null, overrideId: '' })).toEqual(
    [],
  )
  expect(evidenceReferences('review_read', { id: 'independent' })).toEqual([])
})
