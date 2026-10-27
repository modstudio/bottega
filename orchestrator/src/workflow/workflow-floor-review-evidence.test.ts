import { expect, test } from 'bun:test'
import type { TriageReviewRow } from '../review/review-group.ts'
import { reviewRoundsHaveTriageEvidence } from './workflow-floor-evidence.ts'

const review = (number: number, graded: boolean): TriageReviewRow => ({
  reviewRecordId: `review-${number}`,
  reviewNumber: number,
  recordedAt: '2026-10-27T00:00:00Z',
  completedAt: '2026-10-27T00:01:00Z',
  tier: 1,
  role: 'round',
  patchId: 'patch',
  pathSet: '["change.ts"]',
  lensIdentities: ['correctness'],
  lenses: [{ recordId: `lens-${number}`, graded, settled: true }],
  findings: [],
})

test('workflow review evidence rejects rounds made only of delivery-none lenses', () => {
  expect(reviewRoundsHaveTriageEvidence([review(1, false), review(2, false)])).toBe(false)
})

test('workflow review evidence accepts one graded review plus one delivery-none review', () => {
  expect(reviewRoundsHaveTriageEvidence([review(1, true), review(2, false)])).toBe(true)
})
