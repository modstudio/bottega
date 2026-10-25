// concern: session close-out
/** Pure ownership, release classification, and final verdict for one architect session. */

import type { BranchLanding } from '../branch/branch-state.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'

export type SessionOwnedRun = {
  recordId: string
  rootRecordId: string
  sessionId: string | null
  number: number
  status: string
  architectTree: boolean
  worktree: string | null
  project: string | null
  taskKey: string | null
  mintedBranch: string | null
  dirty: boolean
}

export type SessionOwnedBranch = {
  project: string
  branch: string
  taskKey: string | null
  state: BranchLanding['state']
}

export type SessionHeldRunResources = {
  rootRecordId: string
  worktree: boolean
  refGuard: boolean
  retainedRef: boolean
  claim: boolean
  owesRecordedTeardown: boolean
  unknown: boolean
}

export type SessionOwnershipFacts = {
  session: string
  runs: readonly SessionOwnedRun[]
  branches: readonly SessionOwnedBranch[]
  heldRunResources: readonly SessionHeldRunResources[]
  claims: readonly { recordId: string; number: number }[]
  landingIds: readonly string[]
  reviewIds: readonly string[]
}

export function sessionOwnedRunIds(
  session: string,
  rows: readonly {
    recordId: string
    parentRecordId: string | null
    sessionId: string | null
  }[],
): string[] {
  const roots = new Set(
    rows
      .filter((row) => row.parentRecordId === null && row.sessionId === session)
      .map((row) => row.recordId),
  )
  return rows
    .filter((row) => roots.has(row.parentRecordId ?? row.recordId))
    .map((row) => row.recordId)
}

export type SessionMechanicalAction =
  | { kind: 'close-run'; runId: string }
  | { kind: 'remove-tree'; runId: string; path: string }
  | { kind: 'ship-cleanup'; project: string; branch: string; taskKey: string | null }
  | { kind: 'prune-branch'; project: string; branch: string }
  | { kind: 'reconcile-claims'; claims: readonly { recordId: string; number: number }[] }

export type SessionProcessItem =
  | { kind: 'live-run'; runId: string; number: number; status: string }
  | { kind: 'dirty-tree'; runId: string; number: number; path: string }
  | { kind: 'unproved-branch'; project: string; branch: string }
  | { kind: 'landing'; landingId: string }
  | { kind: 'review'; reviewId: string }

export function sessionOwnership(facts: SessionOwnershipFacts): SessionOwnershipFacts {
  const roots = new Set(
    facts.runs
      .filter((run) => run.recordId === run.rootRecordId && run.sessionId === facts.session)
      .map((run) => run.rootRecordId),
  )
  return {
    session: facts.session,
    runs: facts.runs.filter((run) => roots.has(run.rootRecordId)),
    branches: [
      ...new Map(facts.branches.map((row) => [`${row.project}\0${row.branch}`, row])).values(),
    ],
    heldRunResources: facts.heldRunResources.filter((held) => roots.has(held.rootRecordId)),
    claims: [...new Map(facts.claims.map((claim) => [claim.recordId, claim])).values()],
    landingIds: [...new Set(facts.landingIds)],
    reviewIds: [...new Set(facts.reviewIds)],
  }
}

export function plannedTreeOwnerMatches(
  runId: string,
  path: string,
  currentOwners: readonly { runId: string; path: string }[],
): boolean {
  const owners = currentOwners.filter((owner) => owner.path === path)
  return owners.length === 1 && owners[0]?.runId === runId
}

export function classifySessionCloseOut(facts: SessionOwnershipFacts): {
  mechanical: SessionMechanicalAction[]
  process: SessionProcessItem[]
} {
  const owned = sessionOwnership(facts)
  const mechanical: SessionMechanicalAction[] = []
  const process: SessionProcessItem[] = []
  classifyRuns(owned.runs, owned.heldRunResources, mechanical, process)
  classifyBranches(owned.branches, mechanical, process)
  if (owned.claims.length) mechanical.push({ kind: 'reconcile-claims', claims: owned.claims })
  process.push(...owned.landingIds.map((landingId) => ({ kind: 'landing' as const, landingId })))
  process.push(...owned.reviewIds.map((reviewId) => ({ kind: 'review' as const, reviewId })))
  return { mechanical, process }
}

function classifyRuns(
  runs: readonly SessionOwnedRun[],
  heldRunResources: readonly SessionHeldRunResources[],
  mechanical: SessionMechanicalAction[],
  process: SessionProcessItem[],
): void {
  const actedRoots = new Set<string>()
  const dirtyRoots = new Set(runs.filter((run) => run.dirty).map((run) => run.rootRecordId))
  for (const run of runs) {
    if (run.status === 'running' || run.status === 'asking') {
      process.push({
        kind: 'live-run',
        runId: run.recordId,
        number: run.number,
        status: run.status,
      })
      continue
    }
    if (!TERMINAL_RUN_STATUS_SET.has(run.status)) continue
    if (actedRoots.has(run.rootRecordId)) continue
    actedRoots.add(run.rootRecordId)
    const held = heldRunResources.find((candidate) => candidate.rootRecordId === run.rootRecordId)
    if (!holdsReleaseResource(held)) continue
    if (dirtyRoots.has(run.rootRecordId)) {
      const dirty = runs.find(
        (candidate) => candidate.rootRecordId === run.rootRecordId && candidate.dirty,
      )!
      process.push({
        kind: 'dirty-tree',
        runId: dirty.recordId,
        number: dirty.number,
        path: dirty.worktree!,
      })
      continue
    }
    if (run.architectTree && run.worktree) {
      mechanical.push({ kind: 'remove-tree', runId: run.recordId, path: run.worktree })
    } else {
      mechanical.push({ kind: 'close-run', runId: run.rootRecordId })
    }
  }
}

function holdsReleaseResource(held: SessionHeldRunResources | undefined): boolean {
  return Boolean(
    held &&
      (held.worktree ||
        held.refGuard ||
        held.retainedRef ||
        held.claim ||
        held.owesRecordedTeardown ||
        held.unknown),
  )
}

function classifyBranches(
  branches: readonly SessionOwnedBranch[],
  mechanical: SessionMechanicalAction[],
  process: SessionProcessItem[],
): void {
  for (const branch of branches) {
    if (branch.state === 'landed') {
      mechanical.push({
        kind: 'ship-cleanup',
        project: branch.project,
        branch: branch.branch,
        taskKey: branch.taskKey,
      })
    }
    if (branch.state === 'landed' || branch.state === 'superseded' || branch.state === 'empty') {
      mechanical.push({ kind: 'prune-branch', project: branch.project, branch: branch.branch })
    } else {
      process.push({ kind: 'unproved-branch', project: branch.project, branch: branch.branch })
    }
  }
}

export function sessionCloseOutVerdict(input: {
  remainingRuns: number
  remainingTrees: number
  remainingBranches: number
  remainingClaims: number
  remainingLandings: number
  remainingReviews: number
  processItems: number
  errors: number
}): { clean: boolean; residue: number } {
  const residue = Object.values(input).reduce((total, count) => total + count, 0)
  return { clean: residue === 0, residue }
}
