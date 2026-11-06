import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  alreadyLiveReleaseDecision,
  checkoutReleaseDecision,
  ciDeployWaitDecision,
  ciDeployWaitOutcome,
  forwardReleaseDecision,
  postDeployLiveDecision,
  RELEASE_CHECKOUT_DIRTY_REFUSAL,
  releaseAncestryFromExitCode,
  releaseCapturedText,
  releaseCheckoutOutcomeDecision,
  releaseCheckoutTransitionDecision,
  releaseCommandEnvironment,
  releaseLockDecision,
  releaseProcessEnvironment,
  releaseReasonDecision,
  releaseRowProvesCandidate,
  releaseRungProofRefusal,
  releaseTagVersionDecision,
  selectReleaseRung,
  trunkFreshnessDecision,
  unprovableReleaseRungMessage,
} from './release-decision.ts'

describe('CI deploy live wait', () => {
  test('matches when the live commit contains the candidate', () => {
    expect(
      ciDeployWaitDecision({ candidateIsLiveAncestor: true, elapsedMs: 30_000, waitMs: 30_000 }),
    ).toBe('matched')
  })

  test('keeps waiting before the deadline', () => {
    expect(
      ciDeployWaitDecision({ candidateIsLiveAncestor: false, elapsedMs: 29_999, waitMs: 30_000 }),
    ).toBe('keep-waiting')
  })

  test('times out at the deadline', () => {
    expect(
      ciDeployWaitDecision({ candidateIsLiveAncestor: false, elapsedMs: 30_000, waitMs: 30_000 }),
    ).toBe('timed-out')
  })

  test('maps a match to successful ledger and release fields', () => {
    expect(
      ciDeployWaitOutcome({
        decision: 'matched',
        rung: 'production',
        candidate: 'candidate',
        live: 'live',
        elapsedMs: 30_000,
      }),
    ).toEqual({
      ledgerResult: {
        exitCode: 0,
        output: 'live commit live contains CI release candidate candidate after 30 seconds',
      },
      outputTail: 'live commit live contains CI release candidate candidate after 30 seconds',
      liveAfter: 'live',
      liveMatchesCandidate: true,
      warning: null,
    })
  })

  test('maps a timeout to failed ledger and release fields naming the wait', () => {
    const outcome = ciDeployWaitOutcome({
      decision: 'timed-out',
      rung: 'production',
      candidate: 'candidate',
      live: 'old-live',
      elapsedMs: 30 * 60 * 1_000,
    })

    expect(outcome).toEqual({
      ledgerResult: {
        exitCode: 1,
        output:
          'timed out after 1800 seconds waiting for rung production live commit to contain CI release candidate candidate',
      },
      outputTail:
        'timed out after 1800 seconds waiting for rung production live commit to contain CI release candidate candidate',
      liveAfter: 'old-live',
      liveMatchesCandidate: false,
      warning: null,
    })
  })
})

test('an unprovable rung names the complete register remedy', () => {
  expect(
    unprovableReleaseRungMessage(PLATFORM_SLUG, 'fixture', 'production', 'master', [
      { name: 'staging', branch: 'develop', deploy: 'deploy staging' },
      { name: 'production', branch: 'master' },
    ]),
  ).toBe(
    `release rung production declares neither a deploy command nor a live probe and cannot be proved; declare a live probe that prints the commit the running deployment was built from, not a reachability check, with: ${PLATFORM_SLUG} project set fixture --settings '{"release":{"rungs":[{"name":"staging","branch":"develop","deploy":"deploy staging"},{"name":"production","branch":"master","live":"<command that prints the deployed commit sha>"}]}}', then retry`,
  )
})

test('a deploy-only rung names the complete live-probe remedy', () => {
  const rungs = [{ name: 'production', branch: 'master', deploy: 'dispatch production' }]
  expect(
    releaseRungProofRefusal(PLATFORM_SLUG, 'fixture', 'production', 'master', rungs, false),
  ).toBe(
    `release rung production declares a deploy command but no live probe and cannot be proved; declare a live probe that prints the commit the running deployment was built from, not a reachability check, with: ${PLATFORM_SLUG} project set fixture --settings '{"release":{"rungs":[{"name":"production","branch":"master","deploy":"dispatch production","live":"<command that prints the deployed commit sha>"}]}}', then retry`,
  )
})

test('an undeclared required rung names a register remedy that declares it', () => {
  expect(
    unprovableReleaseRungMessage(PLATFORM_SLUG, 'fixture', 'production', 'master', [
      { name: 'staging', branch: 'develop', deploy: 'deploy staging' },
    ]),
  ).toBe(
    `release rung production is required but the register does not declare it; declare it in release.rungs with its branch and a live probe through ${PLATFORM_SLUG} project set fixture --settings '{"release":{"rungs":[{"name":"staging","branch":"develop","deploy":"deploy staging"},{"name":"production","branch":"master","live":"<command that prints the deployed commit sha>"}]}}', then retry`,
  )
})

describe('release ledger row proof', () => {
  const noLiveMatch = {
    exit_code: 0,
    live_matches_candidate: null,
    candidate_commit: 'deployed',
  }

  test('a row without a live match does not prove the deployed commit', () => {
    expect(releaseRowProvesCandidate(noLiveMatch, 'deployed')).toBe(false)
  })

  test('a successful row for another commit does not prove the deployed commit', () => {
    expect(releaseRowProvesCandidate(noLiveMatch, 'different')).toBe(false)
  })

  test('a live rung is proved by a matching row at the deployed commit', () => {
    expect(
      releaseRowProvesCandidate({ ...noLiveMatch, live_matches_candidate: 1 }, 'deployed'),
    ).toBe(true)
  })
})

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
  path: '/projects/example',
  branch: 'main',
  requiredBranch: 'main',
  trunk: 'main',
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
    expect(checkoutReleaseDecision({ ...level, branch: 'develop' })).toEqual({
      ok: false,
      message:
        'the release did not move the registered main checkout; it is on develop, not its landing branch main; run git -C /projects/example switch main, then retry',
    }))
})

describe('release checkout transition', () => {
  test('keeps a same-branch release on trunk without a switch or restore', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: 'main',
        trunk: 'main',
        rungBranch: 'main',
        dirty: false,
      }),
    ).toEqual({
      ok: true,
      switchToRung: false,
      fastForward: false,
      restoreToTrunk: false,
    }))

  test('does not move a same-branch release whose checkout is off trunk', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: 'develop',
        trunk: 'main',
        rungBranch: 'main',
        dirty: false,
      }),
    ).toEqual({
      ok: true,
      switchToRung: false,
      fastForward: false,
      restoreToTrunk: false,
    }))

  test('switches a clean landing branch to the rung and restores it', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: 'develop',
        trunk: 'develop',
        rungBranch: 'master',
        dirty: false,
      }),
    ).toEqual({ ok: true, switchToRung: true, fastForward: true, restoreToTrunk: true }))

  test('heals a clean checkout already left on the rung', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: 'master',
        trunk: 'develop',
        rungBranch: 'master',
        dirty: false,
      }),
    ).toEqual({ ok: true, switchToRung: false, fastForward: true, restoreToTrunk: true }))

  test('refuses a dirty checkout when it would need switching and restoration', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: 'develop',
        trunk: 'develop',
        rungBranch: 'master',
        dirty: true,
      }),
    ).toEqual({
      ok: false,
      message: RELEASE_CHECKOUT_DIRTY_REFUSAL,
    }))

  test('refuses another branch with the landing-branch remedy', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: 'feature',
        trunk: 'develop',
        rungBranch: 'master',
        dirty: false,
      }),
    ).toEqual({
      ok: false,
      message:
        'registered main checkout is on feature, not its landing branch develop; switch it to develop, then retry',
    }))

  test('names detached HEAD when no current branch is reported', () =>
    expect(
      releaseCheckoutTransitionDecision({
        current: '',
        trunk: 'develop',
        rungBranch: 'master',
        dirty: false,
      }),
    ).toEqual({
      ok: false,
      message:
        'registered main checkout is on detached HEAD, not its landing branch develop; switch it to develop, then retry',
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
  test('redacts secret-shaped captured output without dropping surrounding text', () =>
    expect(
      releaseCapturedText(`failed token=credential\n${'ordinary trailing output\n'.repeat(2)}`),
    ).toBe(`failed [withheld: assignment]\n${'ordinary trailing output\n'.repeat(2)}`))

  test('keeps ordinary captured output', () =>
    expect(releaseCapturedText('deploying revision abc123\ndone')).toBe(
      'deploying revision abc123\ndone',
    ))

  test('refuses secret-shaped release reasons with the flag name', () => {
    expect(releaseReasonDecision('rollback', 'credential', true)).toEqual({
      ok: false,
      message: expect.stringContaining('restate the reason without the credential'),
    })
    expect(releaseReasonDecision('behind-trunk', 'credential', true)).toEqual({
      ok: false,
      message: expect.stringContaining('behind-trunk reason'),
    })
  })

  test('refuses an empty redeploy reason', () => {
    expect(releaseReasonDecision('redeploy', ' ', false)).toEqual({
      ok: false,
      message: expect.stringContaining('redeploy reason must be non-empty'),
    })
  })
})

describe('release checkout outcome', () => {
  test('keeps a clean body result unchanged', () =>
    expect(
      releaseCheckoutOutcomeDecision({ failure: null, warning: null, restoreWarning: null }),
    ).toEqual({ ok: true, warning: null }))

  test('keeps a body failure when restoration succeeds', () =>
    expect(
      releaseCheckoutOutcomeDecision({
        failure: 'deploy failed',
        warning: null,
        restoreWarning: null,
      }),
    ).toEqual({ ok: false, message: 'deploy failed' }))

  test('adds a restore failure to a successful body warning', () =>
    expect(
      releaseCheckoutOutcomeDecision({
        failure: null,
        warning: 'live probe failed',
        restoreWarning: 'restore failed',
      }),
    ).toEqual({ ok: true, warning: 'live probe failed; restore failed' }))

  test('adds a restore failure after the original body failure', () =>
    expect(
      releaseCheckoutOutcomeDecision({
        failure: 'deploy failed',
        warning: null,
        restoreWarning: 'restore failed',
      }),
    ).toEqual({ ok: false, message: 'deploy failed; restore failed' }))
})

describe('already-live release decision', () => {
  test.each([
    ['candidate is observed live', true, 0, undefined, undefined, true, false],
    ['landing branch is ahead', true, 2, undefined, undefined, true, true],
    ['candidate is not observed live', false, 0, undefined, undefined, false, false],
    ['redeploy was requested', true, 0, 'repair deploy', undefined, false, false],
    ['rollback was requested', true, 0, undefined, 'deliberate rollback', false, false],
  ] as const)(
    '%s',
    (_label, candidateIsLiveAncestor, commitsBehindTrunk, redeployReason, rollbackReason, alreadyLive, landingAhead) => {
      expect(
        alreadyLiveReleaseDecision({
          candidateIsLiveAncestor,
          commitsBehindTrunk,
          redeployReason,
          rollbackReason,
        }),
      ).toEqual({ alreadyLive, landingAhead })
    },
  )
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
