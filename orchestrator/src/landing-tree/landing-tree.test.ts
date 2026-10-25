import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type HeldTreeInFlightFacts,
  type HeldTreeWorkFacts,
  heldTreeInFlight,
  heldTreeWorkIsUnique,
  LANDING_TREE_JOB,
  landingTreeCommandBase,
  landingTreeCommandCapability,
  landingTreeHoldDecision,
  landingTreeOpeningRefusal,
  landingTreeReleaseDecision,
  landingTreeRunAdoptionDecision,
} from './landing-tree.ts'

describe('landing-tree run adoption', () => {
  const linked = {
    openedOwner: 'operator:machine-id',
    openedCoordinator: true,
    openedLaunchKey: 'DEV-1528',
    openedIssueKey: null,
    candidateOwner: 'operator:machine-id',
    candidateCoordinator: true,
    candidateLaunchKey: 'DEV-1528',
    candidateIssueKey: null,
  }

  test('adopts runs from the same operator owner and launch key', () => {
    expect(landingTreeRunAdoptionDecision(linked)).toBe(true)
  })

  test('does not adopt a different launch key or owner', () => {
    expect(landingTreeRunAdoptionDecision({ ...linked, candidateLaunchKey: 'DEV-OTHER' })).toBe(
      false,
    )
    expect(
      landingTreeRunAdoptionDecision({ ...linked, candidateOwner: 'operator:other-machine' }),
    ).toBe(false)
  })

  test('does not adopt from a session owner', () => {
    expect(
      landingTreeRunAdoptionDecision({
        ...linked,
        openedOwner: 'architect-session',
        candidateOwner: 'architect-session',
      }),
    ).toBe(false)
  })

  test('does not adopt when either run is not a coordinator run', () => {
    expect(landingTreeRunAdoptionDecision({ ...linked, openedCoordinator: false })).toBe(false)
    expect(landingTreeRunAdoptionDecision({ ...linked, candidateCoordinator: false })).toBe(false)
  })

  test('adopts a different launch key through the recorded coordinator issue link', () => {
    expect(
      landingTreeRunAdoptionDecision({
        ...linked,
        openedLaunchKey: 'OTHER-42',
        openedIssueKey: 'DEV-1528',
        candidateIssueKey: 'DEV-1528',
      }),
    ).toBe(true)
  })
})

describe('landing-tree decisions', () => {
  test('keeps a clean existing landing tree without holding close-out', () => {
    expect(
      landingTreeHoldDecision(
        { job: LANDING_TREE_JOB, treeExists: true, branch: 'DEV-1037-orch-1', runId: '1' },
        true,
        { held: false as const },
      ),
    ).toEqual({
      held: false,
      kept: true,
      reason: `clean landing tree; branch DEV-1037-orch-1 holds its work; ${PLATFORM_SLUG} tree open 1 recreates it`,
    })
  })

  test('holds a dirty existing landing tree', () => {
    const ordinary = { held: false as const }
    expect(
      landingTreeHoldDecision(
        { job: LANDING_TREE_JOB, treeExists: true, branch: 'DEV-1037-orch-1', runId: '1' },
        false,
        ordinary,
      ),
    ).toEqual({
      held: true,
      until: null,
      reason: `landing tree; remove with ${PLATFORM_SLUG} tree remove <path>`,
      hold: 'unique-work',
    })
  })

  test('leaves a non-landing-tree row unchanged', () => {
    const ordinary = { held: true as const, until: null, reason: 'ordinary hold' }
    expect(
      landingTreeHoldDecision(
        { job: 'implement', treeExists: true, branch: 'DEV-1037-orch-1', runId: '1' },
        true,
        ordinary,
      ),
    ).toBe(ordinary)
  })

  test('names opening refusals and their remedies', () => {
    expect(landingTreeOpeningRefusal({ branch: null })).toContain('use a finished writer run')
  })
  test('requires command templates to accept an existing branch', () => {
    expect(landingTreeCommandCapability('scripts/tree add {branch} {base}')).toEqual({
      allowed: true,
    })
    expect(landingTreeCommandCapability('scripts/tree add {base}')).toMatchObject({
      allowed: false,
    })
    expect(
      landingTreeCommandCapability({ pipeline: 'printf %s {branch} | scripts/tree add' }),
    ).toEqual({ allowed: true })
  })

  test('uses registered trunk for command-template base', () => {
    expect(landingTreeCommandBase('develop')).toBe('develop')
    expect(() => landingTreeCommandBase(undefined)).toThrow('no registered trunk')
  })

  test.each([
    [true, true, { action: 'release' }],
    [
      false,
      true,
      {
        action: 'keep' as const,
        reason: 'landing tree held by session owner: tree is dirty',
        hold: 'unique-work' as const,
      },
    ],
    [
      true,
      false,
      {
        action: 'keep' as const,
        reason: `landing tree held by session owner: branch has not landed; session owner releases it with ${PLATFORM_SLUG} tree remove <path>`,
        hold: 'landing-progress' as const,
      },
    ],
  ] as const)('decides release from clean=%s landed=%s', (clean, landed, expected) => {
    expect(
      landingTreeReleaseDecision(
        {
          job: LANDING_TREE_JOB,
          sessionId: 'owner',
          treeExists: true,
          status: 'ok',
          landingInFlight: false,
          explicitTreeRemovalRequested: false,
        },
        clean,
        landed,
      ),
    ).toEqual(expected)
  })

  test('releases an absent terminal tree only when no landing is in flight', () => {
    const facts = {
      job: LANDING_TREE_JOB,
      sessionId: 'owner',
      treeExists: false,
      status: 'ok',
      landingInFlight: false,
      explicitTreeRemovalRequested: false,
    }
    expect(landingTreeReleaseDecision(facts, false, false)).toEqual({ action: 'release' })
    expect(landingTreeReleaseDecision({ ...facts, landingInFlight: true }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: landing is in flight',
      hold: 'landing-progress',
    })
    expect(landingTreeReleaseDecision({ ...facts, status: 'running' }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: conversation is running',
      hold: 'other',
    })
  })

  test.each([true, false])(
    'keeps a present clean tree while landing is in flight (landed=%s)',
    (landed) => {
      expect(
        landingTreeReleaseDecision(
          {
            job: LANDING_TREE_JOB,
            sessionId: 'owner',
            treeExists: true,
            status: 'ok',
            landingInFlight: true,
            explicitTreeRemovalRequested: false,
          },
          true,
          landed,
        ),
      ).toEqual({
        action: 'keep',
        reason: 'landing tree held by session owner: landing is in flight',
        hold: 'landing-progress',
      })
    },
  )

  test('explicit removal releases a present clean tree before its branch lands', () => {
    const facts = {
      job: LANDING_TREE_JOB,
      sessionId: 'owner',
      treeExists: true,
      status: 'ok',
      landingInFlight: false,
      explicitTreeRemovalRequested: true,
    }
    expect(landingTreeReleaseDecision(facts, true, false)).toEqual({ action: 'release' })
    expect(landingTreeReleaseDecision(facts, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: tree is dirty',
      hold: 'unique-work',
    })
    expect(landingTreeReleaseDecision({ ...facts, landingInFlight: true }, true, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: landing is in flight',
      hold: 'landing-progress',
    })
  })

  test('explicit removal leaves absent-tree holds unchanged', () => {
    const facts = {
      job: LANDING_TREE_JOB,
      sessionId: 'owner',
      treeExists: false,
      status: 'ok',
      landingInFlight: false,
      explicitTreeRemovalRequested: true,
    }
    expect(landingTreeReleaseDecision(facts, false, false)).toEqual({ action: 'release' })
    expect(landingTreeReleaseDecision({ ...facts, landingInFlight: true }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: landing is in flight',
      hold: 'landing-progress',
    })
    expect(landingTreeReleaseDecision({ ...facts, status: 'running' }, false, false)).toEqual({
      action: 'keep',
      reason: 'landing tree held by session owner: conversation is running',
      hold: 'other',
    })
  })

  test('does not change ordinary or hook-tree sweep policy', () => {
    expect(
      landingTreeReleaseDecision(
        {
          job: 'hook-tree',
          sessionId: 'owner',
          treeExists: true,
          status: 'ok',
          landingInFlight: false,
          explicitTreeRemovalRequested: false,
        },
        false,
        false,
      ),
    ).toEqual({ action: 'release' })
  })
})

describe('held-tree unique work', () => {
  const facts = (overrides: Partial<HeldTreeWorkFacts> = {}): HeldTreeWorkFacts => ({
    hold: 'unique-work',
    treeClean: true,
    openPrHead: 'sha-head',
    treeHead: 'sha-head',
    ...overrides,
  })

  test('a clean tree whose HEAD is its open pull request head is not unique work', () => {
    expect(heldTreeWorkIsUnique(facts())).toBe(false)
  })

  test('a tree with uncommitted work is unique work', () => {
    expect(heldTreeWorkIsUnique(facts({ treeClean: false }))).toBe(true)
  })

  test('a pull request head other than the tree HEAD is unique work', () => {
    expect(heldTreeWorkIsUnique(facts({ openPrHead: 'sha-other' }))).toBe(true)
  })

  test('no open pull request is unique work', () => {
    expect(heldTreeWorkIsUnique(facts({ openPrHead: null }))).toBe(true)
  })

  test('an unreadable tree HEAD is unique work', () => {
    expect(heldTreeWorkIsUnique(facts({ treeHead: null }))).toBe(true)
    expect(heldTreeWorkIsUnique(facts({ treeHead: null, openPrHead: null }))).toBe(true)
  })

  test('an other hold judges by the same facts', () => {
    expect(heldTreeWorkIsUnique(facts({ hold: 'other' }))).toBe(false)
    expect(heldTreeWorkIsUnique(facts({ hold: 'other', treeClean: false }))).toBe(true)
    expect(heldTreeWorkIsUnique(facts({ hold: 'other', openPrHead: null }))).toBe(true)
  })

  test('a landing-progress hold is in flight whatever the facts say', () => {
    expect(
      heldTreeWorkIsUnique({
        hold: 'landing-progress',
        treeClean: false,
        openPrHead: null,
        treeHead: null,
      }),
    ).toBe(false)
  })
})

describe('held-tree in-flight landing', () => {
  const cursor = (overrides: Partial<NonNullable<HeldTreeInFlightFacts['cursor']>> = {}) => ({
    id: 459,
    workflow: 'ship-task',
    step: 'merge-pr',
    live: true,
    project: 'fixture',
    branch: 'DEV-1594-ship',
    worktree: '/landing-tree',
    ...overrides,
  })
  const facts = (overrides: Partial<HeldTreeInFlightFacts> = {}): HeldTreeInFlightFacts => ({
    treePath: '/landing-tree',
    project: 'fixture',
    branch: 'DEV-1594-ship',
    cursor: cursor(),
    openPr: null,
    hold: 'landing-progress',
    treeClean: false,
    treeHead: null,
    ...overrides,
  })

  test('a matching worktree cursor at merge-pr is in flight and does not block', () => {
    expect(heldTreeInFlight(facts())).toEqual({
      ref: 'cursor 459 merge-pr',
      suppressBlock: true,
    })
  })

  test('a cursor for another tree is not in flight for this tree', () => {
    expect(heldTreeInFlight(facts({ cursor: cursor({ worktree: '/other-tree' }) }))).toBeNull()
  })

  test('a dirty unique-work hold still carries the matching cursor without suppressing', () => {
    expect(heldTreeInFlight(facts({ hold: 'unique-work' }))).toEqual({
      ref: 'cursor 459 merge-pr',
      suppressBlock: false,
    })
  })

  test('a clean other hold at its open pull request head suppresses, and the cursor names the line', () => {
    expect(
      heldTreeInFlight(
        facts({
          hold: 'other',
          treeClean: true,
          treeHead: 'sha-head',
          openPr: { ref: '#88', headOid: 'sha-head' },
        }),
      ),
    ).toEqual({ ref: 'cursor 459 merge-pr', suppressBlock: true })
  })

  test('an open PR without a cursor is in flight and does not block', () => {
    expect(
      heldTreeInFlight(facts({ cursor: null, openPr: { ref: '#88', headOid: null } })),
    ).toEqual({ ref: '#88', suppressBlock: true })
  })

  test('an other hold at its open pull request head is in flight without a cursor', () => {
    expect(
      heldTreeInFlight(
        facts({
          cursor: null,
          hold: 'other',
          treeClean: true,
          treeHead: 'sha-head',
          openPr: { ref: '#88', headOid: 'sha-head' },
        }),
      ),
    ).toEqual({ ref: '#88', suppressBlock: true })
  })

  test('an other hold whose pull request head is another commit keeps blocking', () => {
    expect(
      heldTreeInFlight(
        facts({
          cursor: null,
          hold: 'other',
          treeClean: true,
          treeHead: 'sha-tree',
          openPr: { ref: '#88', headOid: 'sha-pr' },
        }),
      ),
    ).toEqual({ ref: '#88', suppressBlock: false })
  })

  test('neither cursor nor PR is not in flight', () => {
    expect(heldTreeInFlight(facts({ cursor: null, openPr: null }))).toBeNull()
  })

  test('finish-ship-cleanup without a PR is not in flight', () => {
    expect(heldTreeInFlight(facts({ cursor: cursor({ step: 'finish-ship-cleanup' }) }))).toBeNull()
  })
})
