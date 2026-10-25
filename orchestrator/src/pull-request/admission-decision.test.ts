import { describe, expect, test } from 'bun:test'
import { type AdmissionOverride, decideAdmission } from './admission-decision.ts'
import type { TriageDecision } from './triage-decision.ts'

const incomplete: TriageDecision = {
  complete: false,
  snapshot: {
    reviewRecordIds: [],
    patchId: 'patch-a',
    tier: 1,
    lensRounds: 0,
    findingCount: 0,
    admissionPath: 'exact_review',
    readRecordId: null,
  },
  missingReview: true,
  unfinishedReviewNumbers: [],
  undisposedFindings: [],
  missingLenses: [{ lens: 'correctness', recordedOnBranch: false, newlyTouchedPaths: [] }],
  lensesAlreadyComplete: [],
  missingSecondOpinion: null,
  architectReadRequired: false,
  earlierReviewNumber: null,
  earlierReviewTier: null,
  finalTierRaised: false,
  noCompleteReviewRound: true,
}

const change = {
  project: 'fixture',
  branch: 'DEV-977-fixture',
  tip: 'tip-new',
  tree: 'tree-new',
  patchId: 'patch-new',
  pathSet: '["a.ts"]',
}

const override = (values: Partial<AdmissionOverride> = {}): AdmissionOverride => ({
  recordId: 'override-17',
  attribution: 'operator',
  missingLenses: [],
  ...change,
  ...values,
})

describe('pull-request admission decision', () => {
  test('an override for the exact tip and change group admits', () => {
    expect(decideAdmission(change, incomplete, [override()])).toEqual({
      complete: true,
      overrideId: 'override-17',
      triage: incomplete,
    })
  })

  test('an architect ruling admits only the exact recorded missing-lens gap', () => {
    const ceiling = override({
      recordId: 'ceiling-ruling',
      attribution: 'architect-ceiling',
      missingLenses: ['correctness'],
    })
    const ceilingGap = { ...incomplete, noCompleteReviewRound: false }
    expect(decideAdmission(change, ceilingGap, [ceiling]).overrideId).toBe('ceiling-ruling')
    expect(
      decideAdmission(
        change,
        {
          ...ceilingGap,
          missingLenses: [
            ...incomplete.missingLenses,
            { lens: 'craft', recordedOnBranch: false, newlyTouchedPaths: [] },
          ],
        },
        [ceiling],
      ).overrideId,
    ).toBeNull()
    expect(
      decideAdmission({ ...change, tip: 'different-head' }, ceilingGap, [ceiling]).overrideId,
    ).toBeNull()
    expect(
      decideAdmission(
        change,
        {
          ...ceilingGap,
          undisposedFindings: [{ reviewNumber: 4, ordinal: 1 }],
        },
        [ceiling],
      ).overrideId,
    ).toBeNull()
  })

  test('a missing second-opinion ruling does not admit a missing primary lens', () => {
    const ceiling = override({
      recordId: 'ceiling-ruling',
      attribution: 'architect-ceiling',
      missingLenses: ['second-opinion:correctness'],
    })
    const ceilingGap = {
      ...incomplete,
      noCompleteReviewRound: false,
      missingLenses: [],
      missingSecondOpinion: { lens: 'correctness', firstRunId: 'run-1' },
    }
    expect(decideAdmission(change, ceilingGap, [ceiling]).overrideId).toBe('ceiling-ruling')
    expect(
      decideAdmission(
        change,
        {
          ...ceilingGap,
          missingLenses: [{ lens: 'correctness', recordedOnBranch: false, newlyTouchedPaths: [] }],
          missingSecondOpinion: null,
        },
        [ceiling],
      ).overrideId,
    ).toBeNull()
  })

  test.each([
    ['an older tip', { tip: 'tip-old', tree: 'tree-old' }],
    ['another project', { project: 'other' }],
    ['another branch', { branch: 'DEV-977-other' }],
    ['another tree', { tree: 'tree-old' }],
    ['another patch', { patchId: 'patch-old' }],
    ['another path set', { pathSet: '["b.ts"]' }],
    ['a null change group from an old-shape payload', { patchId: null, pathSet: null }],
  ])('an override for %s does not admit', (_label, values) => {
    expect(decideAdmission(change, incomplete, [override(values)])).toEqual({
      complete: false,
      overrideId: null,
      triage: incomplete,
    })
  })

  test('without an override the triage result is unchanged', () => {
    expect(decideAdmission(change, incomplete, [])).toEqual({
      complete: false,
      overrideId: null,
      triage: incomplete,
    })
    const complete: TriageDecision = {
      complete: true,
      snapshot: { ...incomplete.snapshot, reviewRecordIds: ['review-4'], lensRounds: 1 },
    }
    expect(decideAdmission(change, complete, [])).toEqual({
      complete: true,
      overrideId: null,
      triage: complete,
    })
  })
})
