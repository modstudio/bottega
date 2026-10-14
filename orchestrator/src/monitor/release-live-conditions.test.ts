import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ReleaseLiveObservation, releaseLiveConditions } from './release-live-conditions.ts'

const observation = (
  rung: string,
  live: ReleaseLiveObservation['live'],
  lastReleasedCommit: string | null,
): ReleaseLiveObservation => ({ project: 'adanim', rung, live, lastReleasedCommit })

describe('release live conditions', () => {
  test('equal commits give no condition', () => {
    expect(releaseLiveConditions([observation('production', { commit: 'abc' }, 'abc')])).toEqual({
      conditions: [],
      errors: [],
    })
  })

  test('different commits give one report-only condition with both commits', () => {
    const result = releaseLiveConditions([
      observation('production', { commit: 'live-commit' }, 'released-commit'),
    ])
    expect(result.errors).toEqual([])
    expect(result.conditions).toEqual([
      expect.objectContaining({
        kind: 'release-live-differs',
        subject: 'adanim:production',
        detail: expect.stringMatching(/adanim.*production.*live-commit.*released-commit/),
        action: `report only; once the cause is understood, run ${PLATFORM_SLUG} release run adanim --rung production`,
      }),
    ])
  })

  test('no successful ledger row gives nothing, whatever the reading', () => {
    expect(
      releaseLiveConditions([
        observation('production', { commit: 'abc' }, null),
        observation('preview', { failure: 'live reading timed out' }, null),
      ]),
    ).toEqual({ conditions: [], errors: [] })
  })

  test('a failed reading gives an error and no condition', () => {
    expect(
      releaseLiveConditions([
        observation('production', { failure: 'live reading timed out' }, 'released'),
      ]),
    ).toEqual({
      conditions: [],
      errors: ['adanim release rung production live reading failed: live reading timed out'],
    })
  })

  test('two rungs are judged independently', () => {
    const result = releaseLiveConditions([
      observation('preview', { commit: 'same' }, 'same'),
      observation('production', { commit: 'new' }, 'old'),
    ])
    expect(result.errors).toEqual([])
    expect(result.conditions).toHaveLength(1)
    expect(result.conditions[0]).toMatchObject({ subject: 'adanim:production' })
  })
})
