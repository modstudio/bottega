import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'
import { type AdmissionOverride, decideAdmission } from './admission-decision.ts'

const change = {
  project: 'fixture',
  taskKey: 'DEV-977',
  branch: 'DEV-977-fixture',
  head: 'tip-new',
  patchId: 'patch-new',
  pathSet: '["a.ts"]',
  paths: ['a.ts'],
}

const verdict = (
  action: ReviewFunnelVerdict['next']['action'],
  overridden: string[] = [],
): ReviewFunnelVerdict => ({
  policyVersion: 'builtin',
  mode: 'evaluate',
  change,
  tier: { tier: 1, risk: 1, size: 1, firm: false, lowered: false, reasons: [] },
  budget: { roundsUsed: 1, ceiling: 1, atCeiling: true },
  lenses: overridden.map((lens) => ({ lens, status: 'overridden', reason: 'overridden' })),
  next: { action },
  remedy: `${PLATFORM_SLUG} pr create`,
})

const override = (values: Partial<AdmissionOverride> = {}): AdmissionOverride => ({
  recordId: 'override-17',
  attribution: 'operator',
  reason: 'operator accepted this exact head',
  missingLenses: [],
  project: change.project,
  branch: change.branch,
  patchId: change.patchId,
  pathSet: change.pathSet,
  tip: change.head,
  tree: 'tree-new',
  ...values,
})

describe('pull-request admission decision', () => {
  test('the funnel verdict is the admission answer', () => {
    expect(decideAdmission(verdict('dispatch'), [])).toEqual({
      complete: false,
      overrideId: null,
      overrideReason: null,
    })
    expect(decideAdmission(verdict('admit'), [])).toEqual({
      complete: true,
      overrideId: null,
      overrideReason: null,
    })
  })

  test('an operator override for the exact patch and path set is credited', () => {
    expect(decideAdmission(verdict('admit'), [override()])).toEqual({
      complete: true,
      overrideId: 'override-17',
      overrideReason: 'operator accepted this exact head',
    })
  })

  test('an exact operator override admits while the funnel still owes work', () => {
    expect(decideAdmission(verdict('dispatch'), [override()])).toEqual({
      complete: true,
      overrideId: 'override-17',
      overrideReason: 'operator accepted this exact head',
    })
  })

  test('a stale operator override does not admit while the funnel still owes work', () => {
    expect(decideAdmission(verdict('dispatch'), [override({ tip: 'tip-old' })])).toEqual({
      complete: false,
      overrideId: null,
      overrideReason: null,
    })
  })

  test('an architect ruling is credited only for the exact overridden-lens gap', () => {
    const ceiling = override({
      recordId: 'ceiling-ruling',
      attribution: 'architect-ceiling',
      missingLenses: ['correctness'],
    })
    expect(decideAdmission(verdict('admit', ['correctness']), [ceiling]).overrideId).toBe(
      'ceiling-ruling',
    )
    expect(
      decideAdmission(verdict('admit', ['correctness', 'craft']), [ceiling]).overrideId,
    ).toBeNull()
    expect(decideAdmission(verdict('admit', ['craft']), [ceiling]).overrideId).toBeNull()
  })

  test('a missing second-opinion ruling does not credit a missing primary lens', () => {
    const ceiling = override({
      attribution: 'architect-ceiling',
      missingLenses: ['second-opinion:correctness'],
    })
    expect(
      decideAdmission(verdict('admit', ['second-opinion:correctness']), [ceiling]).overrideId,
    ).toBe('override-17')
    expect(decideAdmission(verdict('admit', ['correctness']), [ceiling]).overrideId).toBeNull()
  })

  test.each([
    ['another project', { project: 'other' }],
    ['another branch', { branch: 'DEV-977-other' }],
    ['another patch', { patchId: 'patch-old' }],
    ['another path set', { pathSet: '["b.ts"]' }],
    ['a null change group from an old-shape payload', { patchId: null, pathSet: null }],
  ])('an override for %s is not credited', (_label, values) => {
    expect(decideAdmission(verdict('admit'), [override(values)])).toEqual({
      complete: true,
      overrideId: null,
      overrideReason: null,
    })
  })

  test('an override survives another tree when the exact head is unchanged', () => {
    const values = { tree: 'tree-old' }
    expect(decideAdmission(verdict('admit'), [override(values)])).toEqual({
      complete: true,
      overrideId: 'override-17',
      overrideReason: 'operator accepted this exact head',
    })
  })
})
