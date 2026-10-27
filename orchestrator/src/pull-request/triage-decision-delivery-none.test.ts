import { expect, test } from 'bun:test'
import { decideTriage, type TriageEvidence } from './triage-decision.ts'

const producedNothing = (reviewId: number, patchId: string): TriageEvidence['reviews'][number] => ({
  reviewRecordId: `review-${reviewId}`,
  reviewNumber: reviewId,
  recordedAt: '2026-09-25T00:00:00Z',
  completedAt: '2026-09-25T01:00:00Z',
  tier: 1,
  role: 'round',
  patchId,
  pathSet: '["a.ts"]',
  lensIdentities: ['correctness'],
  lenses: [{ recordId: `lens-${reviewId}-0`, lens: 'correctness', graded: false, settled: true }],
  findings: [],
})

const evidence = (overrides: Partial<TriageEvidence>): TriageEvidence => ({
  patchId: 'patch-a',
  pathSet: '["a.ts"]',
  tip: 'tip-a',
  tier: 1,
  applicableReview: { lenses: ['correctness'] },
  branchOwnerSession: 'owner-session',
  reviews: [],
  branchReviewGroups: [],
  reads: [],
  ...overrides,
})

test('a settled delivery-none lens does not cover its lens on either admission path', () => {
  expect(decideTriage(evidence({ reviews: [producedNothing(4, 'patch-a')] })).complete).toBe(false)
  expect(
    decideTriage(
      evidence({
        branchReviewGroups: [{ reviews: [producedNothing(3, 'patch-old')] }],
        reads: [
          {
            recordId: 'record-9',
            tip: 'tip-a',
            patchId: 'patch-a',
            pathSet: '["a.ts"]',
            recordedAt: '2026-09-25T02:00:00Z',
            sessionId: 'owner-session',
          },
        ],
      }),
    ).complete,
  ).toBe(false)
})
