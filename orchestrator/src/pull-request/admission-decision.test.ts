import { describe, expect, test } from 'bun:test'
import { type AdmissionOverride, decideAdmission } from './admission-decision.ts'
import type { TriageDecision } from './triage-decision.ts'

const incomplete: TriageDecision = {
  complete: false,
  snapshot: {
    reviewIds: [],
    patchId: 'patch-a',
    tier: 1,
    lensRounds: 0,
    findingCount: 0,
    admissionPath: 'exact_review',
    readId: null,
  },
  missingReview: true,
  unfinishedReviewIds: [],
  undisposedFindings: [],
  missingLenses: ['correctness'],
  architectReadRequired: false,
  earlierReviewId: null,
  earlierReviewTier: null,
  finalTierRaised: false,
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
  id: 17,
  ...change,
  ...values,
})

describe('pull-request admission decision', () => {
  test('an override for the exact tip and change group admits', () => {
    expect(decideAdmission(change, incomplete, [override()])).toEqual({
      complete: true,
      overrideId: 17,
      triage: incomplete,
    })
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
      snapshot: { ...incomplete.snapshot, reviewIds: [4], lensRounds: 1 },
    }
    expect(decideAdmission(change, complete, [])).toEqual({
      complete: true,
      overrideId: null,
      triage: complete,
    })
  })
})
