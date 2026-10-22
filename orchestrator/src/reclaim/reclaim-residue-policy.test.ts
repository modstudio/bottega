import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  GIT_LOCK_RECLAIM_AGE_MS,
  gitLockReleaseDecision,
  processReleaseDecision,
  refGuardReleaseDecision,
  retainedRefReleaseDecision,
  sandboxReleaseDecision,
  staleRunReleaseDecision,
  trustReleaseDecision,
} from './reclaim-residue-policy.ts'

describe('residue release decisions', () => {
  test('git-lock requires a registered lock path, known empty owners, and the age floor', () => {
    const safe = {
      path: '/projects/example/.git/worktrees/orch-1/index.lock',
      projects: [{ name: 'example', gitCommonDir: '/projects/example/.git' }],
      ownerPids: [] as number[] | null,
      ageMs: GIT_LOCK_RECLAIM_AGE_MS,
    }
    expect(gitLockReleaseDecision(safe)).toMatchObject({
      allowed: true,
      projectName: 'example',
      relativePath: 'worktrees/orch-1/index.lock',
    })

    const refusals = [
      {
        facts: { ...safe, ownerPids: [42] },
        invariant: 'the lock has no live owner',
        fix: 'wait for owner pid 42 to release it',
      },
      {
        facts: { ...safe, ownerPids: null },
        invariant: 'the lock owner inventory is known',
        fix: 'restore lsof access and retry',
      },
      {
        facts: { ...safe, ageMs: GIT_LOCK_RECLAIM_AGE_MS - 1 },
        invariant: 'the lock mtime is at least 10 minutes old',
        fix: 'wait until the lock reaches the age floor, then retry',
      },
      {
        facts: { ...safe, path: '/outside/index.lock' },
        invariant: "the lock is inside a registered project's Git common directory",
        fix: 'register the project or pass a lock beneath its Git common directory',
      },
      {
        facts: { ...safe, path: '/projects/example/.git/index' },
        invariant: 'the subject is an absolute path whose file name ends .lock',
        fix: 'pass the absolute path of a Git lock file',
      },
    ]
    for (const refusal of refusals) {
      expect(gitLockReleaseDecision(refusal.facts)).toEqual({
        allowed: false,
        refusal: `refused; invariant: ${refusal.invariant}; fix: ${refusal.fix}`,
      })
    }
  })

  test('ref-guard requires an existing guard, no tree, and no live conversation', () => {
    expect(
      refGuardReleaseDecision({ exists: true, worktreeExists: false, conversationLive: false })
        .allowed,
    ).toBe(true)
    expect(
      refGuardReleaseDecision({ exists: false, worktreeExists: false, conversationLive: false })
        .allowed,
    ).toBe(false)
    expect(
      refGuardReleaseDecision({ exists: true, worktreeExists: true, conversationLive: false })
        .allowed,
    ).toBe(false)
    expect(
      refGuardReleaseDecision({ exists: true, worktreeExists: false, conversationLive: true })
        .allowed,
    ).toBe(false)
  })

  test('sandbox refuses missing ownership, a live turn, and a live process', () => {
    expect(
      sandboxReleaseDecision({
        exists: true,
        conversationExists: true,
        conversationTerminal: true,
        processAlive: false,
      }).allowed,
    ).toBe(true)
    expect(
      sandboxReleaseDecision({
        exists: false,
        conversationExists: true,
        conversationTerminal: true,
        processAlive: false,
      }).allowed,
    ).toBe(false)
    expect(
      sandboxReleaseDecision({
        exists: true,
        conversationExists: false,
        conversationTerminal: false,
        processAlive: false,
      }).allowed,
    ).toBe(false)
    expect(
      sandboxReleaseDecision({
        exists: true,
        conversationExists: true,
        conversationTerminal: false,
        processAlive: false,
      }).allowed,
    ).toBe(false)
    expect(
      sandboxReleaseDecision({
        exists: true,
        conversationExists: true,
        conversationTerminal: true,
        processAlive: true,
      }).allowed,
    ).toBe(false)
  })

  test('retained ref requires the ref, its run, and terminal status', () => {
    expect(
      retainedRefReleaseDecision({ exists: true, runExists: true, terminal: true }).allowed,
    ).toBe(true)
    expect(
      retainedRefReleaseDecision({ exists: false, runExists: true, terminal: true }).allowed,
    ).toBe(false)
    expect(
      retainedRefReleaseDecision({ exists: true, runExists: false, terminal: false }).allowed,
    ).toBe(false)
    expect(
      retainedRefReleaseDecision({ exists: true, runExists: true, terminal: false }).allowed,
    ).toBe(false)
  })

  test('trust refuses every unproved ownership and path invariant', () => {
    const safe = {
      recorded: true,
      pathKnown: true,
      orchWorktreePath: true,
      mainCheckout: false,
      pathExists: false,
      headingExists: true,
    }
    expect(trustReleaseDecision(safe).allowed).toBe(true)
    for (const unsafe of [
      { ...safe, recorded: false },
      { ...safe, pathKnown: false },
      { ...safe, orchWorktreePath: false },
      { ...safe, mainCheckout: true },
      { ...safe, pathExists: true },
      { ...safe, headingExists: false },
    ])
      expect(trustReleaseDecision(unsafe).allowed).toBe(false)
  })

  test('process signals only when both recorded identity parts match', () => {
    expect(
      processReleaseDecision({
        runExists: true,
        terminal: true,
        alive: true,
        startTimeMatches: true,
        commandMatches: true,
      }),
    ).toEqual({ allowed: true, action: 'signal' })
    expect(
      processReleaseDecision({
        runExists: true,
        terminal: true,
        alive: true,
        startTimeMatches: true,
        commandMatches: true,
        signalAllowed: false,
      }),
    ).toEqual({
      allowed: false,
      refusal:
        'refused; invariant: unattended reclaim never signals a live process; fix: reclaim this process manually',
    })
    expect(
      processReleaseDecision({
        runExists: true,
        terminal: true,
        alive: true,
        startTimeMatches: false,
        commandMatches: true,
      }),
    ).toEqual({ allowed: true, action: 'record-released' })
    expect(
      processReleaseDecision({
        runExists: true,
        terminal: true,
        alive: true,
        startTimeMatches: false,
        commandMatches: false,
        signalAllowed: false,
      }),
    ).toEqual({
      allowed: false,
      refusal:
        'refused; invariant: unattended reclaim never signals a live process; fix: reclaim this process manually',
    })
    expect(
      processReleaseDecision({
        runExists: true,
        terminal: true,
        alive: true,
        startTimeMatches: true,
        commandMatches: false,
      }),
    ).toEqual({ allowed: true, action: 'record-released' })
    expect(
      processReleaseDecision({
        runExists: false,
        terminal: false,
        alive: false,
        startTimeMatches: false,
        commandMatches: false,
      }).allowed,
    ).toBe(false)
    expect(
      processReleaseDecision({
        runExists: true,
        terminal: false,
        alive: true,
        startTimeMatches: true,
        commandMatches: true,
      }).allowed,
    ).toBe(false)
  })

  test('stale-run requires an unexcluded stale row', () => {
    expect(
      staleRunReleaseDecision({
        runId: '7',
        runExists: true,
        status: 'stale',
        alreadyExcluded: false,
      }).allowed,
    ).toBe(true)
    expect(
      staleRunReleaseDecision({
        runId: '7',
        runExists: false,
        status: null,
        alreadyExcluded: false,
      }).allowed,
    ).toBe(false)
    expect(
      staleRunReleaseDecision({ runId: '7', runExists: true, status: 'ok', alreadyExcluded: false })
        .allowed,
    ).toBe(false)
    expect(
      staleRunReleaseDecision({
        runId: '7',
        runExists: true,
        status: 'stale',
        alreadyExcluded: true,
      }).allowed,
    ).toBe(false)
  })

  test('stale-run refusal names the lifecycle verb for each live status', () => {
    expect(
      staleRunReleaseDecision({
        runId: '41',
        runExists: true,
        status: 'running',
        alreadyExcluded: false,
      }),
    ).toEqual({
      allowed: false,
      refusal: `refused; invariant: the run status is stale; fix: run ${PLATFORM_SLUG} run stop 41`,
    })
    expect(
      staleRunReleaseDecision({
        runId: '42',
        runExists: true,
        status: 'asking',
        alreadyExcluded: false,
      }),
    ).toEqual({
      allowed: false,
      refusal: `refused; invariant: the run status is stale; fix: run ${PLATFORM_SLUG} run abandon 42`,
    })
    expect(
      staleRunReleaseDecision({
        runId: '43',
        runExists: true,
        status: 'failed',
        alreadyExcluded: false,
      }),
    ).toEqual({
      allowed: false,
      refusal:
        'refused; invariant: the run status is stale; fix: the run is already terminal (failed); no lifecycle verb applies',
    })
  })
})
