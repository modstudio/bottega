import { describe, expect, test } from 'bun:test'
import { decideShipToReach } from './ship-to-reach.ts'

describe('ship-to reach', () => {
  test.each([
    ['branch', false],
    ['trunk', true],
    ['production', true],
  ] as const)('%s with no rungs', (level, mayMerge) => {
    expect(decideShipToReach(level, [])).toEqual({
      allowed: true,
      mayMerge,
      reach: [],
      remaining: [],
      skipped: [],
    })
  })

  test('branch and trunk leave every rung remaining and ignore depth', () => {
    const rungs = [{ name: 'staging' }, { name: 'production' }]
    expect(decideShipToReach('branch', rungs, 'absent')).toEqual({
      allowed: true,
      mayMerge: false,
      reach: [],
      remaining: ['staging', 'production'],
      skipped: [],
    })
    expect(decideShipToReach('trunk', rungs, 'staging')).toEqual({
      allowed: true,
      mayMerge: true,
      reach: [],
      remaining: ['staging', 'production'],
      skipped: [],
    })
  })

  test('production reaches every rung when depth is absent', () => {
    expect(decideShipToReach('production', [{ name: 'staging' }, { name: 'production' }])).toEqual({
      allowed: true,
      mayMerge: true,
      reach: ['staging', 'production'],
      remaining: [],
      skipped: [],
    })
  })

  test('production depth reaches through the named first rung', () => {
    expect(
      decideShipToReach('production', [{ name: 'staging' }, { name: 'production' }], 'staging'),
    ).toEqual({
      allowed: true,
      mayMerge: true,
      reach: ['staging'],
      remaining: ['production'],
      skipped: [],
    })
  })

  test('production refuses a depth that names no registered rung', () => {
    expect(
      decideShipToReach('production', [{ name: 'staging' }, { name: 'production' }], 'preview'),
    ).toEqual({
      allowed: false,
      refusal:
        'ship-to depth "preview" names no registered release rung; registered rungs: staging, production; pass a registered rung name or omit depth',
    })
  })

  test.each([
    {
      case: 'declared and matched',
      rung: { name: 'npm', releasesWhenChanged: ['package.json', 'src/**'] },
      merge: { changedPaths: ['src/index.ts'] },
      reach: ['npm'],
      skipped: [],
    },
    {
      case: 'declared and unmatched',
      rung: { name: 'npm', releasesWhenChanged: ['package.json', 'src/**'] },
      merge: { changedPaths: ['scripts/verify.ts'] },
      reach: [],
      skipped: [
        {
          name: 'npm',
          reason:
            'no release artifact in this change: no changed path matches package.json, src/**',
        },
      ],
    },
    {
      case: 'undeclared with a merge',
      rung: { name: 'npm' },
      merge: { changedPaths: ['scripts/verify.ts'] },
      reach: ['npm'],
      skipped: [],
    },
    {
      case: 'declared without a merge',
      rung: { name: 'npm', releasesWhenChanged: ['package.json'] },
      merge: undefined,
      reach: ['npm'],
      skipped: [],
    },
  ])('$case', ({ rung, merge, reach, skipped }) => {
    expect(decideShipToReach('production', [rung], undefined, merge)).toEqual({
      allowed: true,
      mayMerge: true,
      reach: [...reach],
      remaining: [],
      skipped: [...skipped],
    })
  })
})
