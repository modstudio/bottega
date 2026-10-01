import { describe, expect, test } from 'bun:test'
import {
  checkoutReleaseDecision,
  forwardReleaseDecision,
  postDeployLiveDecision,
  releaseLockDecision,
} from './release-decision.ts'

const level = {
  branch: 'main',
  requiredBranch: 'main',
  dirty: false,
  head: 'b'.repeat(40),
  remoteHead: 'b'.repeat(40),
  ahead: 0,
  behind: 0,
}

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
