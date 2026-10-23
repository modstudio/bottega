import { describe, expect, test } from 'bun:test'
import { latestRecordReleases, type RecordRelease } from './record-release-reading.ts'

const release = (
  id: string,
  rung: string,
  startedAt: string,
  finishedAt: string | null,
  exitCode: number | null,
): RecordRelease => ({
  id,
  rung,
  candidateCommit: `candidate-${id}`,
  trunk: 'main',
  trunkTip: `candidate-${id}`,
  commitsBehindTrunk: 0,
  behindTrunkReason: null,
  liveCommitBefore: null,
  liveCommitAfter: null,
  rollback: false,
  rollbackReason: null,
  actor: 'operator',
  sessionId: null,
  startedAt,
  finishedAt,
  exitCode,
  liveMatchesCandidate: null,
  warning: null,
})

describe('latest record releases', () => {
  test('keeps the newest successful release beside a later failed attempt', () => {
    const good = release(
      'a',
      'production',
      '2026-10-10T00:00:00.000Z',
      '2026-10-10T00:01:00.000Z',
      0,
    )
    const failed = release(
      'b',
      'production',
      '2026-10-11T00:00:00.000Z',
      '2026-10-11T00:01:00.000Z',
      1,
    )
    expect(latestRecordReleases([failed, good])).toEqual([
      { rung: 'production', lastGood: good, latestAttempt: failed },
    ])
  })

  test('reports an unfinished release beside the last good release', () => {
    const good = release(
      'a',
      'production',
      '2026-10-10T00:00:00.000Z',
      '2026-10-10T00:01:00.000Z',
      0,
    )
    const unfinished = release('b', 'production', '2026-10-11T00:00:00.000Z', null, null)
    expect(latestRecordReleases([good, unfinished])).toEqual([
      { rung: 'production', lastGood: good, latestAttempt: unfinished },
    ])
  })

  test('a rung with only failures has no last good release', () => {
    const older = release('a', 'staging', '2026-10-10T00:00:00.000Z', '2026-10-10T00:01:00.000Z', 1)
    const newest = release(
      'b',
      'staging',
      '2026-10-11T00:00:00.000Z',
      '2026-10-11T00:01:00.000Z',
      2,
    )
    expect(latestRecordReleases([older, newest])).toEqual([
      { rung: 'staging', lastGood: null, latestAttempt: newest },
    ])
  })

  test('selects rungs independently and omits an attempt identical to the last good release', () => {
    const production = release(
      'b',
      'production',
      '2026-10-11T00:00:00.000Z',
      '2026-10-11T00:01:00.000Z',
      0,
    )
    const staging = release('a', 'staging', '2026-10-10T00:00:00.000Z', null, null)
    expect(latestRecordReleases([staging, production])).toEqual([
      { rung: 'production', lastGood: production, latestAttempt: null },
      { rung: 'staging', lastGood: null, latestAttempt: staging },
    ])
  })
})
