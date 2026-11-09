// concern: session close-out
/** Pure ownership, release classification, and final verdict for one architect session. */

import type { BranchLanding } from '../branch/branch-state.ts'
import type { ContextItemKind } from '../doc/doc-context-write.ts'
import { RUN_LIVE_STATUSES, TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'

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

export type SessionContextAction = 'drop' | 'refuse' | 'keep'

export type SessionCursorDisposition = 'parked' | 'open'

export type UnreadableProjectDisposition = 'error' | 'warning'

export type SessionOutboxRow = {
  id: number
  actorSession: string | null
  syncedAt: string | null
  quarantinedAt: string | null
  retiredAt: string | null
}

export type SessionOutboxResidue = {
  pendingIds: number[]
  quarantinedIds: number[]
}

/** Count only undelivered writes attributed to the session being closed. */
export function sessionOutboxResidue(
  session: string,
  rows: readonly SessionOutboxRow[],
): SessionOutboxResidue {
  const owned = rows.filter(
    (row) => row.actorSession === session && row.syncedAt === null && row.retiredAt === null,
  )
  return {
    pendingIds: owned.filter((row) => row.quarantinedAt === null).map((row) => row.id),
    quarantinedIds: owned.filter((row) => row.quarantinedAt !== null).map((row) => row.id),
  }
}

/** An unreadable project blocks only while this session still owns work close-out must settle. */
export function classifyUnreadableProject(ownsCloseOutWork: boolean): UnreadableProjectDisposition {
  return ownsCloseOutWork ? 'error' : 'warning'
}

export type UnreadableProjectOwnershipFacts = {
  project: string
  runs: readonly Pick<SessionOwnedRun, 'rootRecordId' | 'project' | 'status' | 'mintedBranch'>[]
  branches: readonly SessionOwnedBranch[]
  heldRunResources: readonly SessionHeldRunResources[]
  cursors: readonly { project: string }[]
}

/** Whether one unreadable project still contains work this session must settle. */
export function ownsUnreadableProjectWork(facts: UnreadableProjectOwnershipFacts): boolean {
  const projectRuns = facts.runs.filter((run) => run.project === facts.project)
  const roots = new Set(projectRuns.map((run) => run.rootRecordId))
  if (projectRuns.some((run) => isLiveSessionRun(run.status))) return true
  if (
    facts.heldRunResources.some(
      (held) => roots.has(held.rootRecordId) && (held.worktree || held.claim),
    )
  )
    return true
  if (
    projectRuns.some((run) => {
      if (!run.mintedBranch) return false
      const branch = facts.branches.find(
        (candidate) => candidate.project === facts.project && candidate.branch === run.mintedBranch,
      )
      return !branch || !isBranchProved(branch)
    })
  )
    return true
  return facts.cursors.some((cursor) => cursor.project === facts.project)
}

/** Classify whether a workflow cursor leaves work for close-out or a successor. */
export function classifySessionCursor(input: {
  state: string
  hasOpenQuestion: boolean
}): SessionCursorDisposition {
  if (input.state === 'awaiting-ruling' && input.hasOpenQuestion) return 'parked'
  return 'open'
}

/** Classify one session-scoped context item without consulting lifecycle state. */
export function classifySessionContextItem(
  kind: ContextItemKind,
  resume: boolean,
): SessionContextAction {
  if (resume) return 'keep'
  return kind === 'ruling' || kind === 'open-question' ? 'refuse' : 'drop'
}

export function sessionCloseOutRecommendation(input: {
  residue: number
  parkedCursors: number
}): 'clear' | 'brief' {
  return input.residue === 0 && input.parkedCursors === 0 ? 'clear' : 'brief'
}

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
  classifyBranches(owned.runs, owned.branches, mechanical, process)
  if (owned.claims.length) mechanical.push({ kind: 'reconcile-claims', claims: owned.claims })
  process.push(...owned.landingIds.map((landingId) => ({ kind: 'landing' as const, landingId })))
  process.push(...owned.reviewIds.map((reviewId) => ({ kind: 'review' as const, reviewId })))
  return { mechanical, process }
}

const RUN_LIVE_STATUS_SET: ReadonlySet<string> = new Set(RUN_LIVE_STATUSES)

export function isLiveSessionRun(status: string): boolean {
  return RUN_LIVE_STATUS_SET.has(status)
}

/** Derive the roots whose run/tree close-out is planned by these actions. */
export function plannedSessionRunRoots(
  actions: readonly SessionMechanicalAction[],
  runs: readonly Pick<SessionOwnedRun, 'recordId' | 'rootRecordId'>[],
): string[] {
  return actions.flatMap((action) => {
    if (action.kind === 'close-run') return [action.runId]
    if (action.kind !== 'remove-tree') return []
    const run = runs.find((candidate) => candidate.recordId === action.runId)
    return run ? [run.rootRecordId] : []
  })
}

function isTerminalSessionRun(status: string): boolean {
  return TERMINAL_RUN_STATUS_SET.has(status)
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

function isBranchProved(branch: SessionOwnedBranch): boolean {
  return branch.state === 'landed' || branch.state === 'superseded' || branch.state === 'empty'
}

export type ResumeHandoffRootFacts = {
  runs: readonly Pick<SessionOwnedRun, 'status'>[]
  pendingScore: boolean
  branches: readonly SessionOwnedBranch[]
  heldRunResources: SessionHeldRunResources | undefined
}

/**
 * Whether a resume handoff's author still owes work on one root.
 *
 * Incomplete reviews are represented by their unscored lens runs: while a review is incomplete,
 * those roots remain pending-score roots. Close-out's existing run, resource, and branch predicates
 * are composed here so the handoff cannot invent different meanings for those facts.
 */
export function resumeHandoffRootIsOwed(facts: ResumeHandoffRootFacts): boolean {
  return (
    facts.runs.some((run) => !isTerminalSessionRun(run.status)) ||
    facts.pendingScore ||
    facts.branches.some((branch) => !isBranchProved(branch)) ||
    holdsReleaseResource(facts.heldRunResources)
  )
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
    if (isLiveSessionRun(run.status)) {
      process.push({
        kind: 'live-run',
        runId: run.recordId,
        number: run.number,
        status: run.status,
      })
      continue
    }
    if (!isTerminalSessionRun(run.status)) continue
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

function classifyBranches(
  runs: readonly SessionOwnedRun[],
  branches: readonly SessionOwnedBranch[],
  mechanical: SessionMechanicalAction[],
  process: SessionProcessItem[],
): void {
  const liveBranches = new Set(
    runs
      .filter((run) => isLiveSessionRun(run.status) && run.project && run.mintedBranch)
      .map((run) => `${run.project}\0${run.mintedBranch}`),
  )
  for (const branch of branches) {
    if (liveBranches.has(`${branch.project}\0${branch.branch}`)) continue
    if (branch.state === 'landed') {
      mechanical.push({
        kind: 'ship-cleanup',
        project: branch.project,
        branch: branch.branch,
        taskKey: branch.taskKey,
      })
    }
    if (isBranchProved(branch)) {
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
  keptContextItems?: number
  errors: number
}): { clean: boolean; residue: number } {
  const residue = Object.values(input).reduce((total, count) => total + (count ?? 0), 0)
  return { clean: residue === 0, residue }
}
