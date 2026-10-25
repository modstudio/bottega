import { expect, test } from 'bun:test'
import { decideTriage, missingLensNames, type TriageEvidence } from './triage-decision.ts'

test('missing lens names normalize coverage and second-opinion gaps', () => {
  const evidence: TriageEvidence = {
    patchId: 'patch',
    pathSet: '["a.ts"]',
    tip: 'tip',
    tier: 3,
    applicableReview: { lenses: ['safety', 'correctness'], secondOpinion: 'correctness' },
    branchOwnerSession: null,
    reviews: [],
    branchReviewGroups: [],
    reads: [],
  }
  expect(missingLensNames(decideTriage(evidence))).toEqual(['correctness', 'safety'])
})
