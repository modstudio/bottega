// concern: landing-tree
/** Pure identity, capability, base, and release decisions for architect landing trees. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isOperatorSession } from '../../../shared/caller-classification.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import type { WorktreeCreate } from '../worktree/worktree-template.ts'
import { createHasPlaceholder } from '../worktree/worktree-template.ts'

export { LANDING_TREE_JOB }
export const LANDING_TREE_AGENT = '(architect)'
export const LANDING_TREE_EVIDENCE_EXCLUSION = 'landing tree lifecycle row; not agent execution'

export type LandingTreeRunRow = {
  record_id: string
  parent_run_record_id: string | null
  repo: string | null
  project_record_id: string | null
  cwd: string | null
  worktree: string | null
  branch: string | null
  branch_kept: string | null
  branch_kept_tip: string | null
  launch_cwd: string | null
  launch_key: string | null
  launch_seed: string | null
  session_id: string | null
  job: string
  label: string | null
}

export type LandingTreeRunAdoptionFacts = {
  openedOwner: string | null
  openedCoordinator: boolean
  openedLaunchKey: string | null
  openedIssueKey: string | null
  candidateOwner: string | null
  candidateCoordinator: boolean
  candidateLaunchKey: string | null
  candidateIssueKey: string | null
}

/** Adopt only coordinator roots tied to the opened run by recorded identity. */
export function landingTreeRunAdoptionDecision(input: LandingTreeRunAdoptionFacts): boolean {
  if (
    !input.openedCoordinator ||
    !input.candidateCoordinator ||
    !isOperatorSession(input.openedOwner) ||
    input.candidateOwner !== input.openedOwner
  )
    return false
  if (input.openedLaunchKey !== null && input.candidateLaunchKey === input.openedLaunchKey)
    return true
  return input.openedIssueKey !== null && input.candidateIssueKey === input.openedIssueKey
}

export function landingTreeOpeningRefusal(input: {
  branch: string | null
  commandHasBranch?: boolean
}): string | null {
  if (!input.branch) return 'the conversation has no recorded branch; use a finished writer run'
  if (input.commandHasBranch === false) {
    return 'the command-template create lifecycle has no {branch} placeholder; edit the project register so worktree.create accepts {branch} to open an existing branch'
  }
  return null
}

export function landingTreeCommandCapability(
  create: WorktreeCreate | string,
): { allowed: true } | { allowed: false; reason: string } {
  return createHasPlaceholder(create, 'branch')
    ? { allowed: true }
    : {
        allowed: false,
        reason: landingTreeOpeningRefusal({
          branch: 'recorded',
          commandHasBranch: false,
        })!,
      }
}

/** A command-backed landing tree compares its existing branch with registered trunk. */
export function landingTreeCommandBase(trunk: string | undefined): string {
  if (!trunk?.trim()) {
    throw new Error(
      'the project has no registered trunk; set settings.trunk before opening a command-template landing tree',
    )
  }
  return trunk.trim()
}

export type LandingTreeHoldKind = 'landing-progress' | 'unique-work' | 'other'

export type LandingTreeReleaseDecision =
  | { action: 'release' }
  | { action: 'keep'; reason: string; hold: LandingTreeHoldKind }

function keep(reason: string, hold: LandingTreeHoldKind): LandingTreeReleaseDecision {
  return { action: 'keep', reason, hold }
}

/** Release an absent terminal landing tree, or a present tree when its release policy permits. */
export function landingTreeReleaseDecision(
  row: {
    job: string
    sessionId: string | null
    treeExists: boolean
    status: string
    landingInFlight: boolean
    explicitTreeRemovalRequested: boolean
  },
  clean: boolean,
  landed: boolean,
): LandingTreeReleaseDecision {
  if (row.job !== LANDING_TREE_JOB) return { action: 'release' }
  const owner = row.sessionId ? `session ${row.sessionId}` : 'its invoking session'
  if (!row.treeExists) {
    if (!TERMINAL_RUN_STATUS_SET.has(row.status)) {
      return keep(`landing tree held by ${owner}: conversation is ${row.status}`, 'other')
    }
    if (row.landingInFlight) {
      return keep(`landing tree held by ${owner}: landing is in flight`, 'landing-progress')
    }
    return { action: 'release' }
  }
  if (!clean) return keep(`landing tree held by ${owner}: tree is dirty`, 'unique-work')
  if (row.explicitTreeRemovalRequested) {
    if (row.landingInFlight) {
      return keep(`landing tree held by ${owner}: landing is in flight`, 'landing-progress')
    }
    return { action: 'release' }
  }
  if (row.landingInFlight) {
    return keep(`landing tree held by ${owner}: landing is in flight`, 'landing-progress')
  }
  if (!landed)
    return keep(
      `landing tree held by ${owner}: branch has not landed; ` +
        `${owner} releases it with ${PLATFORM_SLUG} tree remove <path>`,
      'landing-progress',
    )
  return { action: 'release' }
}

export function landingTreeHoldDecision<T>(
  row: { job: string; treeExists: boolean; branch: string | null; runId: string },
  clean: boolean,
  ordinary: T,
):
  | T
  | { held: true; until: null; reason: string; hold: 'unique-work' }
  | { held: false; kept: true; reason: string } {
  if (row.job !== LANDING_TREE_JOB || !row.treeExists) return ordinary
  if (!clean) {
    return {
      held: true,
      until: null,
      reason: `landing tree; remove with ${PLATFORM_SLUG} tree remove <path>`,
      hold: 'unique-work' as const,
    }
  }
  return {
    held: false,
    kept: true,
    reason:
      `clean landing tree; branch ${row.branch ?? '<unknown>'} holds its work; ` +
      `${PLATFORM_SLUG} tree open ${row.runId} recreates it`,
  }
}

const SHIP_TASK_WORKFLOW = 'ship-task'
const AFTER_FINISH_SHIP_CLEANUP = new Set(['finish-ship-cleanup', 'promote-release', 'close-task'])

type HeldTreeCursorFacts = {
  id: number
  workflow: string | null
  step: string | null
  live: boolean
  project: string | null
  branch: string | null
  worktree: string | null
}

export type HeldTreeOpenPr = { ref: string; headOid: string | null }

export type HeldTreeInFlightFacts = {
  treePath: string
  project: string | null
  branch: string | null
  cursor: HeldTreeCursorFacts | null
  openPr: HeldTreeOpenPr | null
  hold: LandingTreeHoldKind
  treeClean: boolean
  treeHead: string | null
}

/** The facts that decide whether a held tree still holds work nothing else has. */
export type HeldTreeWorkFacts = {
  hold: LandingTreeHoldKind
  treeClean: boolean
  openPrHead: string | null
  treeHead: string | null
}

/**
 * Whether the held tree is the only copy of its work.
 *
 * A clean tree whose HEAD is the head of its own open pull request has its commits on origin, so
 * the hold preserves nothing and the tree is in flight. Uncommitted work, a pull request for a
 * different commit, no open pull request at all, or an unreadable HEAD leave the work unique. A
 * landing-progress hold is in flight already.
 */
export function heldTreeWorkIsUnique(facts: HeldTreeWorkFacts): boolean {
  if (facts.hold === 'landing-progress') return false
  return !(facts.treeClean && facts.treeHead !== null && facts.treeHead === facts.openPrHead)
}

type HeldTreeInFlight = { ref: string; suppressBlock: boolean }

function shipTaskCursorIsInFlight(
  cursor: Pick<HeldTreeCursorFacts, 'workflow' | 'step' | 'live'>,
): boolean {
  return (
    cursor.live &&
    cursor.workflow === SHIP_TASK_WORKFLOW &&
    !AFTER_FINISH_SHIP_CLEANUP.has(cursor.step ?? '')
  )
}

function cursorMatchesThisTree(
  tree: Pick<HeldTreeInFlightFacts, 'treePath' | 'project' | 'branch'>,
  cursor: HeldTreeCursorFacts | null,
): cursor is HeldTreeCursorFacts {
  return Boolean(
    cursor &&
      tree.project &&
      tree.branch &&
      tree.treePath &&
      shipTaskCursorIsInFlight(cursor) &&
      cursor.project === tree.project &&
      cursor.branch === tree.branch &&
      cursor.worktree === tree.treePath,
  )
}

function inFlightRef(facts: HeldTreeInFlightFacts): string | null {
  const cursor = facts.cursor
  if (cursorMatchesThisTree(facts, cursor)) {
    return cursor.step ? `cursor ${cursor.id} ${cursor.step}` : `cursor ${cursor.id}`
  }
  return facts.openPr?.ref ?? null
}

/** Cursor or open PR for this exact tree; a hold whose work is unique carries the fact too. */
export function heldTreeInFlight(facts: HeldTreeInFlightFacts): HeldTreeInFlight | null {
  const ref = inFlightRef(facts)
  if (!ref) return null
  const unique = heldTreeWorkIsUnique({
    hold: facts.hold,
    treeClean: facts.treeClean,
    openPrHead: facts.openPr?.headOid ?? null,
    treeHead: facts.treeHead,
  })
  return { ref, suppressBlock: !unique }
}
