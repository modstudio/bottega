// concern: landing-tree
/** Pure identity, capability, base, and release decisions for architect landing trees. */

import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import type { WorktreeCreate } from '../worktree/worktree-template.ts'
import { createHasPlaceholder } from '../worktree/worktree-template.ts'

export { LANDING_TREE_JOB }
export const LANDING_TREE_AGENT = '(architect)'
export const LANDING_TREE_EVIDENCE_EXCLUSION = 'landing tree lifecycle row; not agent execution'

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

export type LandingTreeReleaseDecision = { action: 'release' } | { action: 'keep'; reason: string }

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
    if (!['ok', 'failed', 'stale', 'stopped'].includes(row.status)) {
      return {
        action: 'keep',
        reason: `landing tree held by ${owner}: conversation is ${row.status}`,
      }
    }
    if (row.landingInFlight) {
      return { action: 'keep', reason: `landing tree held by ${owner}: landing is in flight` }
    }
    return { action: 'release' }
  }
  if (!clean) return { action: 'keep', reason: `landing tree held by ${owner}: tree is dirty` }
  if (row.explicitTreeRemovalRequested) {
    if (row.landingInFlight) {
      return { action: 'keep', reason: `landing tree held by ${owner}: landing is in flight` }
    }
    return { action: 'release' }
  }
  if (!landed)
    return {
      action: 'keep',
      reason:
        `landing tree held by ${owner}: branch has not landed; ` +
        `${owner} releases it with orch tree remove <path>`,
    }
  return { action: 'release' }
}

export function landingTreeHoldDecision<T>(
  row: { job: string; treeExists: boolean; branch: string | null; runId: number },
  clean: boolean,
  ordinary: T,
): T | { held: true; until: null; reason: string } | { held: false; kept: true; reason: string } {
  if (row.job !== LANDING_TREE_JOB || !row.treeExists) return ordinary
  if (!clean) {
    return { held: true, until: null, reason: 'landing tree; remove with orch tree remove <path>' }
  }
  return {
    held: false,
    kept: true,
    reason:
      `clean landing tree; branch ${row.branch ?? '<unknown>'} holds its work; ` +
      `orch tree open ${row.runId} recreates it`,
  }
}
