import { describe, expect, test } from 'bun:test'
import {
  processReleaseDecision,
  refGuardReleaseDecision,
  retainedRefReleaseDecision,
  sandboxReleaseDecision,
  staleRunReleaseDecision,
  trustReleaseDecision,
} from './reclaim-residue-policy.ts'

describe('residue release decisions', () => {
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
        startTimeMatches: false,
        commandMatches: true,
      }),
    ).toEqual({ allowed: true, action: 'record-released' })
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
        runId: 7,
        runExists: true,
        status: 'stale',
        alreadyExcluded: false,
      }).allowed,
    ).toBe(true)
    expect(
      staleRunReleaseDecision({ runId: 7, runExists: false, status: null, alreadyExcluded: false })
        .allowed,
    ).toBe(false)
    expect(
      staleRunReleaseDecision({ runId: 7, runExists: true, status: 'ok', alreadyExcluded: false })
        .allowed,
    ).toBe(false)
    expect(
      staleRunReleaseDecision({ runId: 7, runExists: true, status: 'stale', alreadyExcluded: true })
        .allowed,
    ).toBe(false)
  })

  test('stale-run refusal names the lifecycle verb for each live status', () => {
    expect(
      staleRunReleaseDecision({
        runId: 41,
        runExists: true,
        status: 'running',
        alreadyExcluded: false,
      }),
    ).toEqual({
      allowed: false,
      refusal: 'refused; invariant: the run status is stale; fix: run orch stop 41',
    })
    expect(
      staleRunReleaseDecision({
        runId: 42,
        runExists: true,
        status: 'asking',
        alreadyExcluded: false,
      }),
    ).toEqual({
      allowed: false,
      refusal: 'refused; invariant: the run status is stale; fix: run orch abandon 42',
    })
    expect(
      staleRunReleaseDecision({
        runId: 43,
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
