import { describe, expect, test } from 'bun:test'
import { type ResumeTreeFacts, resumeTreePlan } from './resume-tree.ts'

const base: ResumeTreeFacts = {
  rootId: 3970,
  branch: 'technical/ADN-123-orch-3970',
  recordedTreeMatches: false,
  hasCreate: false,
  branchTip: 'branch-tip',
  retainedTip: 'retained-tip',
  recordedTip: 'recorded-tip',
}

describe('resume tree decision', () => {
  test('attaches the matching recorded tree without requiring a recoverable tip', () => {
    expect(
      resumeTreePlan({
        ...base,
        recordedTreeMatches: true,
        branchTip: null,
        retainedTip: null,
        recordedTip: null,
      }),
    ).toEqual({
      action: 'attach-recorded',
      branch: 'technical/ADN-123-orch-3970',
      tip: null,
      rootId: 3970,
    })
  })

  test('recreates the recorded branch through the Git fallback', () => {
    expect(resumeTreePlan(base)).toEqual({
      action: 'recreate-on-branch',
      branch: 'technical/ADN-123-orch-3970',
      tip: 'branch-tip',
      rootId: 3970,
    })
  })

  test('recreates through the declared lifecycle before restoring the tip', () => {
    expect(resumeTreePlan({ ...base, hasCreate: true })).toEqual({
      action: 'recreate-then-restore',
      branch: 'technical/ADN-123-orch-3970',
      tip: 'branch-tip',
      rootId: 3970,
    })
  })

  test('refuses when no retained tip exists', () => {
    expect(
      resumeTreePlan({ ...base, branchTip: null, retainedTip: null, recordedTip: null }),
    ).toEqual({
      action: 'refuse',
      branch: 'technical/ADN-123-orch-3970',
      tip: null,
      rootId: 3970,
    })
  })

  test.each([
    ['branch ref', base, 'branch-tip'],
    ['retained ref', { ...base, branchTip: null }, 'retained-tip'],
    ['recorded close-out tip', { ...base, branchTip: null, retainedTip: null }, 'recorded-tip'],
  ] as const)('uses the %s tip before lower-precedence sources', (_name, facts, tip) => {
    expect(resumeTreePlan(facts)).toMatchObject({ action: 'recreate-on-branch', tip })
  })
})
