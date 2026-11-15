import { describe, expect, test } from 'bun:test'
import { exploreGraduation, type ExploreGraduationCandidate } from './explore-graduation.ts'

const untouched = (overrides: Partial<ExploreGraduationCandidate> = {}) => ({
  cursor: 845,
  recordId: 'explore-record',
  closedSteps: 0,
  hasOpenQuestion: false,
  attachedText: 0,
  ...overrides,
})

describe('explore graduation', () => {
  test('closes only an untouched explore when the new cursor is task-bound', () => {
    expect(exploreGraduation({ taskBound: true, explore: untouched() })).toEqual({
      action: 'close',
      cursor: 845,
      recordId: 'explore-record',
    })
    expect(exploreGraduation({ taskBound: false, explore: untouched() })).toEqual({
      action: 'keep',
    })
  })

  test.each([
    ['closed step', { closedSteps: 1 }],
    ['open question', { hasOpenQuestion: true }],
    ['attached text', { attachedText: 1 }],
  ])('keeps an explore with %s', (_label, touched) => {
    expect(exploreGraduation({ taskBound: true, explore: untouched(touched) })).toEqual({
      action: 'keep',
    })
  })
})
