import { describe, expect, test } from 'bun:test'
import {
  classifySessionCloseOut,
  plannedTreeOwnerMatches,
  type SessionOwnershipFacts,
  sessionCloseOutVerdict,
  sessionOwnedRunIds,
  sessionOwnership,
} from './session-close-out-decision.ts'

const facts = (overrides: Partial<SessionOwnershipFacts> = {}): SessionOwnershipFacts => ({
  session: 'owner',
  runs: [],
  branches: [],
  heldRunResources: [],
  claimIds: [],
  landingIds: [],
  reviewIds: [],
  ...overrides,
})

describe('session close-out decisions', () => {
  test('run ownership includes every turn in a chain the session dispatched', () => {
    expect(
      sessionOwnedRunIds('owner', [
        { recordId: 'root', parentRecordId: null, sessionId: 'owner' },
        { recordId: 'turn', parentRecordId: 'root', sessionId: 'other' },
        { recordId: 'other', parentRecordId: null, sessionId: 'other' },
        { recordId: 'adopted-turn', parentRecordId: 'other', sessionId: 'owner' },
      ]),
    ).toEqual(['root', 'turn'])
  })

  test('ownership keeps turns and deduplicates durable resources', () => {
    const owned = sessionOwnership(
      facts({
        runs: [
          {
            recordId: 'root',
            rootRecordId: 'root',
            sessionId: 'owner',
            number: 1,
            status: 'ok',
            architectTree: false,
            worktree: null,
            project: 'p',
            taskKey: 'DEV-1',
            mintedBranch: 'b',
            dirty: false,
          },
          {
            recordId: 'turn',
            rootRecordId: 'root',
            sessionId: 'other',
            number: 2,
            status: 'failed',
            architectTree: false,
            worktree: null,
            project: 'p',
            taskKey: 'DEV-1',
            mintedBranch: 'b',
            dirty: false,
          },
        ],
        branches: [
          { project: 'p', branch: 'b', taskKey: 'DEV-1', state: 'empty' },
          { project: 'p', branch: 'b', taskKey: 'DEV-1', state: 'empty' },
        ],
        heldRunResources: [
          {
            rootRecordId: 'root',
            worktree: false,
            refGuard: false,
            retainedRef: false,
            claim: false,
            owesRecordedTeardown: false,
            unknown: false,
          },
        ],
        claimIds: [4, 4],
        landingIds: ['l', 'l'],
        reviewIds: ['r', 'r'],
      }),
    )
    expect(owned.runs.map((run) => run.recordId)).toEqual(['root', 'turn'])
    expect(owned.branches).toHaveLength(1)
    expect(owned.claimIds).toEqual([4])
  })

  test('ownership excludes a root dispatched by another session', () => {
    const run = {
      recordId: 'other',
      rootRecordId: 'other',
      sessionId: 'other',
      number: 3,
      status: 'ok',
      architectTree: false,
      worktree: null,
      project: null,
      taskKey: null,
      mintedBranch: null,
      dirty: false,
    }
    expect(sessionOwnership(facts({ runs: [run] })).runs).toEqual([])
  })

  test('separates proved cleanup from live runs and unproved branches', () => {
    const result = classifySessionCloseOut(
      facts({
        runs: [
          {
            recordId: 'done',
            rootRecordId: 'done',
            sessionId: 'owner',
            number: 1,
            status: 'ok',
            architectTree: false,
            worktree: '/tree',
            project: 'p',
            taskKey: 'DEV-1',
            mintedBranch: 'landed',
            dirty: false,
          },
          {
            recordId: 'tree',
            rootRecordId: 'tree',
            sessionId: 'owner',
            number: 2,
            status: 'failed',
            architectTree: true,
            worktree: '/landing',
            project: 'p',
            taskKey: 'DEV-1',
            mintedBranch: null,
            dirty: false,
          },
          {
            recordId: 'live',
            rootRecordId: 'live',
            sessionId: 'owner',
            number: 3,
            status: 'asking',
            architectTree: false,
            worktree: '/live',
            project: 'p',
            taskKey: 'DEV-1',
            mintedBranch: 'unique',
            dirty: false,
          },
        ],
        branches: [
          { project: 'p', branch: 'landed', taskKey: 'DEV-1', state: 'landed' },
          { project: 'p', branch: 'unique', taskKey: 'DEV-1', state: 'unlanded' },
        ],
        heldRunResources: [
          {
            rootRecordId: 'done',
            worktree: true,
            refGuard: false,
            retainedRef: false,
            claim: true,
            owesRecordedTeardown: false,
            unknown: false,
          },
          {
            rootRecordId: 'tree',
            worktree: true,
            refGuard: false,
            retainedRef: false,
            claim: false,
            owesRecordedTeardown: false,
            unknown: false,
          },
        ],
        claimIds: [9],
        landingIds: ['landing'],
        reviewIds: ['review'],
      }),
    )
    expect(result.mechanical.map((item) => item.kind)).toEqual([
      'close-run',
      'remove-tree',
      'ship-cleanup',
      'prune-branch',
      'reconcile-claims',
    ])
    expect(result.process.map((item) => item.kind)).toEqual([
      'live-run',
      'unproved-branch',
      'landing',
      'review',
    ])
  })

  test('dirty trees require a process ruling', () => {
    const result = classifySessionCloseOut(
      facts({
        runs: [
          {
            recordId: 'dirty',
            rootRecordId: 'dirty',
            sessionId: 'owner',
            number: 9,
            status: 'ok',
            architectTree: true,
            worktree: '/dirty',
            project: 'p',
            taskKey: 'DEV-9',
            mintedBranch: null,
            dirty: true,
          },
        ],
        heldRunResources: [
          {
            rootRecordId: 'dirty',
            worktree: true,
            refGuard: false,
            retainedRef: false,
            claim: false,
            owesRecordedTeardown: false,
            unknown: false,
          },
        ],
      }),
    )
    expect(result.mechanical).toEqual([])
    expect(result.process).toEqual([
      { kind: 'dirty-tree', runId: 'dirty', number: 9, path: '/dirty' },
    ])
  })

  test('terminal roots plan close-out only when they still hold a releasable resource', () => {
    const run = {
      recordId: 'done',
      rootRecordId: 'done',
      sessionId: 'owner',
      number: 10,
      status: 'ok',
      architectTree: false,
      worktree: '/tree',
      project: 'p',
      taskKey: 'DEV-10',
      mintedBranch: null,
      dirty: false,
    }
    const held = {
      rootRecordId: 'done',
      worktree: false,
      refGuard: false,
      retainedRef: false,
      claim: false,
      owesRecordedTeardown: false,
      unknown: false,
    }
    expect(classifySessionCloseOut(facts({ runs: [run] })).mechanical).toEqual([])
    for (const resource of [
      'worktree',
      'refGuard',
      'retainedRef',
      'claim',
      'owesRecordedTeardown',
      'unknown',
    ] as const) {
      expect(
        classifySessionCloseOut({
          ...facts({ runs: [run] }),
          heldRunResources: [{ ...held, [resource]: true }],
        }).mechanical,
      ).toContainEqual({ kind: 'close-run', runId: 'done' })
    }
  })

  test('verdict is clean only when no owned or failed item remains', () => {
    expect(
      sessionCloseOutVerdict({
        remainingRuns: 0,
        remainingTrees: 0,
        remainingBranches: 0,
        remainingClaims: 0,
        remainingLandings: 0,
        remainingReviews: 0,
        processItems: 0,
        errors: 0,
      }),
    ).toEqual({ clean: true, residue: 0 })
    expect(
      sessionCloseOutVerdict({
        remainingRuns: 0,
        remainingTrees: 0,
        remainingBranches: 1,
        remainingClaims: 0,
        remainingLandings: 0,
        remainingReviews: 0,
        processItems: 1,
        errors: 0,
      }),
    ).toEqual({ clean: false, residue: 2 })
  })

  test('planned tree identity refuses a path reused by another run', () => {
    expect(
      plannedTreeOwnerMatches('planned', '/tree', [{ runId: 'replacement', path: '/tree' }]),
    ).toBe(false)
    expect(plannedTreeOwnerMatches('planned', '/tree', [{ runId: 'planned', path: '/tree' }])).toBe(
      true,
    )
  })
})
