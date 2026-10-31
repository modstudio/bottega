import { describe, expect, test } from 'bun:test'
import { findingLocationNote, reviewFindingRepositoryPath } from './review-finding-location.ts'

describe('review finding repository paths', () => {
  test.each([
    ['scripts/static-check-plan.ts:10', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10:12', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10-12', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10,12', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10,12-16', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10-12,16', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10,', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts#L10', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts#L10-L12', 'scripts/static-check-plan.ts'],
    ['`scripts/static-check-plan.ts:10,12-16`', 'scripts/static-check-plan.ts'],
    ['scripts/static-check-plan.ts:10,38-53 (in foo)', 'scripts/static-check-plan.ts'],
    ['/scripts/static-check-plan.ts:10,12-16', null],
  ])('extracts %s', (location, expected) => {
    expect(reviewFindingRepositoryPath(location)).toBe(expected)
  })
})

describe('finding location notes', () => {
  test('notes run 22150 finding 1 when its cited path is absent', () => {
    expect(
      findingLocationNote([
        {
          finding: 1,
          path: 'orchestrator/src/supervisor-wait.ts',
          resolution: 'absent',
        },
      ]),
    ).toBe(
      'finding 1 location orchestrator/src/supervisor-wait.ts does not resolve on the reviewed tree',
    )
  })

  test('names absent findings and ignores resolving and unknown facts', () => {
    expect(
      findingLocationNote([
        { finding: 1, path: 'orchestrator/src/present.ts', resolution: 'resolves' },
        {
          finding: 2,
          path: 'orchestrator/src/supervisor-wait.ts',
          resolution: 'absent',
        },
        { finding: 3, path: 'orchestrator/src/unverified.ts', resolution: 'unknown' },
        { finding: 4, path: 'orchestrator/src/also-absent.ts', resolution: 'absent' },
      ]),
    ).toBe(
      'finding 2 location orchestrator/src/supervisor-wait.ts does not resolve on the reviewed tree\n' +
        'finding 4 location orchestrator/src/also-absent.ts does not resolve on the reviewed tree',
    )
  })
})
