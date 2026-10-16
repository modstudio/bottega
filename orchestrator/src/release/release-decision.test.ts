import { describe, expect, test } from 'bun:test'
import {
  checkoutReleaseDecision,
  forwardReleaseDecision,
  postDeployLiveDecision,
  RELEASE_OUTPUT_WITHHELD,
  releaseCapturedText,
  releaseCommandEnvironment,
  releaseLockDecision,
  releaseProcessEnvironment,
  releaseTagVersionDecision,
  rollbackReasonDecision,
  selectReleaseRung,
} from './release-decision.ts'

test('identifies the release to its deploy command', () => {
  expect(releaseCommandEnvironment('project-name', 'hosted-api', 'abc123', false)).toEqual({
    ORCH_RELEASE_PROJECT: 'project-name',
    ORCH_RELEASE_RUNG: 'hosted-api',
    ORCH_RELEASE_COMMIT: 'abc123',
  })
  expect(releaseCommandEnvironment('project-name', 'hosted-api', 'abc123', true)).toEqual({
    ORCH_RELEASE_PROJECT: 'project-name',
    ORCH_RELEASE_RUNG: 'hosted-api',
    ORCH_RELEASE_COMMIT: 'abc123',
    ORCH_RELEASE_ROLLBACK: '1',
  })
})

test('release variables reach only the deploy environment', () => {
  const stale = {
    ORCH_RELEASE_PROJECT: 'stale-project',
    ORCH_RELEASE_RUNG: 'stale-rung',
    ORCH_RELEASE_COMMIT: 'stale-commit',
    ORCH_RELEASE_ROLLBACK: '1',
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
    ORCH_RELEASE_PROJECT: 'project-name',
    ORCH_RELEASE_RUNG: 'rung',
    ORCH_RELEASE_COMMIT: 'commit',
  })
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

describe('release text policy', () => {
  test('withholds secret-shaped captured output', () =>
    expect(
      releaseCapturedText(`token=credential\n${'ordinary trailing output\n'.repeat(2_000)}`, true),
    ).toBe(RELEASE_OUTPUT_WITHHELD))

  test('keeps ordinary captured output', () =>
    expect(releaseCapturedText('deploying revision abc123\ndone', false)).toBe(
      'deploying revision abc123\ndone',
    ))

  test('refuses a secret-shaped rollback reason', () =>
    expect(rollbackReasonDecision(true)).toEqual({
      ok: false,
      message: expect.stringContaining('restate the reason without the credential'),
    }))
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
