import { describe, expect, test } from 'bun:test'
import {
  checkoutReleaseDecision,
  forwardReleaseDecision,
  postDeployLiveDecision,
  RELEASE_OUTPUT_WITHHELD,
  releaseAncestryFromExitCode,
  releaseCapturedText,
  releaseCommandEnvironment,
  releaseLockDecision,
  releaseProcessEnvironment,
  releaseReasonDecision,
  releaseTagVersionDecision,
  selectReleaseRung,
  trunkFreshnessDecision,
} from './release-decision.ts'

test('identifies the release to its deploy command', () => {
  expect(releaseCommandEnvironment('project-name', 'hosted-api', 'abc123', false)).toEqual({
    BOTTEGA_RELEASE_PROJECT: 'project-name',
    BOTTEGA_RELEASE_RUNG: 'hosted-api',
    BOTTEGA_RELEASE_COMMIT: 'abc123',
  })
  expect(releaseCommandEnvironment('project-name', 'hosted-api', 'abc123', true)).toEqual({
    BOTTEGA_RELEASE_PROJECT: 'project-name',
    BOTTEGA_RELEASE_RUNG: 'hosted-api',
    BOTTEGA_RELEASE_COMMIT: 'abc123',
    BOTTEGA_RELEASE_ROLLBACK: '1',
  })
})

test('release variables reach only the deploy environment', () => {
  const stale = {
    BOTTEGA_RELEASE_PROJECT: 'stale-project',
    BOTTEGA_RELEASE_RUNG: 'stale-rung',
    BOTTEGA_RELEASE_COMMIT: 'stale-commit',
    BOTTEGA_RELEASE_ROLLBACK: '1',
    UNRELATED: 'kept',
  }
  expect(releaseProcessEnvironment(stale)).toEqual({ UNRELATED: 'kept' })
  expect(
    releaseProcessEnvironment(
      stale,
      releaseCommandEnvironment('project-name', 'rung', 'commit', false),
    ),
  ).toEqual({
    UNRELATED: 'kept',
    BOTTEGA_RELEASE_PROJECT: 'project-name',
    BOTTEGA_RELEASE_RUNG: 'rung',
    BOTTEGA_RELEASE_COMMIT: 'commit',
  })
})

test('maps git ancestry exit codes to three-valued release ancestry', () => {
  expect(releaseAncestryFromExitCode(0)).toBe(true)
  expect(releaseAncestryFromExitCode(1)).toBe(false)
  expect(releaseAncestryFromExitCode(128)).toBeNull()
})

const level = {
  branch: 'main',
  requiredBranch: 'main',
  dirty: false,
  head: 'b'.repeat(40),
  remoteHead: 'b'.repeat(40),
  ahead: 0,
  behind: 0,
}

test('release tag version accepts a match and refuses a mismatch', () => {
  expect(releaseTagVersionDecision('0.2.0', 'v0.2.0')).toEqual({ ok: true })
  expect(releaseTagVersionDecision('0.1.0', 'v0.2.0')).toEqual({
    ok: false,
    message:
      'reported version 0.1.0 does not match release tag v0.2.0; change package.json before tagging',
  })
  expect(releaseTagVersionDecision('0.2.0', 'release-0.2.0')).toEqual({
    ok: false,
    message: 'release tag release-0.2.0 must match v*',
  })
})

describe('release checkout', () => {
  test('allows a clean level checkout', () =>
    expect(checkoutReleaseDecision(level)).toEqual({ ok: true }))
  test('refuses behind', () =>
    expect(checkoutReleaseDecision({ ...level, behind: 1, head: 'a'.repeat(40) })).toMatchObject({
      ok: false,
      message: expect.stringContaining('behind'),
    }))
  test('refuses ahead', () =>
    expect(checkoutReleaseDecision({ ...level, ahead: 1, head: 'c'.repeat(40) })).toMatchObject({
      ok: false,
      message: expect.stringContaining('ahead'),
    }))
  test('refuses dirty', () =>
    expect(checkoutReleaseDecision({ ...level, dirty: true })).toMatchObject({
      ok: false,
      message: expect.stringContaining('dirty'),
    }))
  test('refuses another branch', () =>
    expect(checkoutReleaseDecision({ ...level, branch: 'develop' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('not main'),
    }))
})

describe('forward-only release', () => {
  test('allows containment', () =>
    expect(
      forwardReleaseDecision({ candidate: 'new', live: 'old', liveIsAncestor: true }),
    ).toMatchObject({ ok: true, rollback: false }))
  test('allows rollback with reason', () =>
    expect(
      forwardReleaseDecision({
        candidate: 'old',
        live: 'new',
        liveIsAncestor: false,
        rollbackReason: 'incident',
      }),
    ).toEqual({ ok: true, rollback: true, reason: 'incident', baseline: false }))
  test('allows first release as baseline', () =>
    expect(forwardReleaseDecision({ candidate: 'new', live: null, liveIsAncestor: null })).toEqual({
      ok: true,
      rollback: false,
      reason: null,
      baseline: true,
    }))
  test('refuses unknown ancestry without a rollback reason', () =>
    expect(
      forwardReleaseDecision({ candidate: 'new', live: 'unknown', liveIsAncestor: null }),
    ).toEqual({
      ok: false,
      message:
        'cannot determine whether live commit unknown is an ancestor of new; fetch unknown into the registered checkout, then retry',
    }))
  test('refuses unknown ancestry with a rollback reason', () =>
    expect(
      forwardReleaseDecision({
        candidate: 'new',
        live: 'unknown',
        liveIsAncestor: null,
        rollbackReason: 'incident',
      }),
    ).toEqual({
      ok: false,
      message:
        'cannot determine whether live commit unknown is an ancestor of new; fetch unknown into the registered checkout, then retry',
    }))
})

describe('release freshness against trunk', () => {
  const facts = {
    trunk: 'develop',
    rungBranch: 'master',
    candidateTrunkBase: 'base-a',
    previousTrunkBase: 'base-a',
    commitsBehind: 337,
    rollback: false,
  }

  test('nothing promoted since the last release refuses with the promotion remedy', () =>
    expect(trunkFreshnessDecision(facts)).toEqual({
      ok: false,
      message:
        'release refused: develop trunk base base-a is unchanged since the last successful master release; develop has 337 commits beyond that shared base not promoted into master; promote develop into master, then retry, or, for an intentional hotfix, pass --behind-trunk "<reason>" to deploy master as it is',
    }))

  test('a promotion followed by more trunk work is allowed and retains the lag', () =>
    expect(trunkFreshnessDecision({ ...facts, candidateTrunkBase: 'base-b' })).toEqual({
      ok: true,
      overrideReason: null,
    }))

  test('a baseline is allowed', () =>
    expect(trunkFreshnessDecision({ ...facts, previousTrunkBase: null })).toEqual({
      ok: true,
      overrideReason: null,
    }))

  test('an override allows an otherwise refused release and normalizes its reason', () =>
    expect(trunkFreshnessDecision({ ...facts, overrideReason: ' intentional hotfix ' })).toEqual({
      ok: true,
      overrideReason: 'intentional hotfix',
    }))

  test('a rollback skips freshness while retaining the trunk facts', () =>
    expect(trunkFreshnessDecision({ ...facts, rollback: true })).toEqual({
      ok: true,
      overrideReason: null,
    }))
})

describe('release text policy', () => {
  test('withholds secret-shaped captured output', () =>
    expect(
      releaseCapturedText(`token=credential\n${'ordinary trailing output\n'.repeat(2_000)}`, true),
    ).toBe(RELEASE_OUTPUT_WITHHELD))

  test('keeps ordinary captured output', () =>
    expect(releaseCapturedText('deploying revision abc123\ndone', false)).toBe(
      'deploying revision abc123\ndone',
    ))

  test('refuses secret-shaped release reasons with the flag name', () => {
    expect(releaseReasonDecision('rollback', true)).toEqual({
      ok: false,
      message: expect.stringContaining('restate the reason without the credential'),
    })
    expect(releaseReasonDecision('behind-trunk', true)).toEqual({
      ok: false,
      message: expect.stringContaining('behind-trunk reason'),
    })
  })
})

test('release lock names its holder', () => {
  expect(releaseLockDecision({ session: 'session-1', since: '2026-10-01T12:00:00Z' })).toEqual({
    ok: false,
    message: expect.stringContaining('session session-1'),
  })
})

test('post-deploy live check matches', () => {
  expect(postDeployLiveDecision('abc', 'abc')).toEqual({ matches: true, warning: null })
})

test('post-deploy live check warns on mismatch', () => {
  expect(postDeployLiveDecision('abc', 'def')).toEqual({
    matches: false,
    warning: expect.stringContaining('does not equal candidate'),
  })
})

test('selects an on-demand rung by name without changing default selection', () => {
  const rungs = [
    { name: 'production', deploy: 'deploy production' },
    { name: 'hosted', deploy: 'deploy hosted', onDemand: true },
  ]

  expect(selectReleaseRung(rungs, 'hosted')).toEqual(rungs[1]!)
  expect(selectReleaseRung(rungs)).toMatchObject({ refusal: expect.stringContaining('--rung') })
})
