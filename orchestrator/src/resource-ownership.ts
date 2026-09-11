// concern: resource-ownership
/**
 * Knows worktree claims, live sharing, and terminal resource teardown. Must not know routing, transports, reviews, contracts, or CLI adapters.
 */
import type { Database } from 'bun:sqlite'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nowIso, sessionId } from './db.ts'
import { DATABASE_RESOLUTION, resolveRunsDirectory } from './database-location.ts'
import { dockerRunResources, resourcesForRuns, teardownRunResources, type DockerTeardown } from './docker-resources.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from './evidence-query.ts'
import { repoRootOf } from './git-environment.ts'
import { realpathOrSpelled, withoutTrailingSeparators } from './checkout-identity.ts'
import { withCleanupLock, withWorktreeLease } from './worktree.ts'

export type WorktreeSharerRow = { id: number; status: string; scored: number }

function worktreeSharers(
  database: Database, row: { id: number; worktree: string }, liveOnly: boolean,
): WorktreeSharerRow[] {
  // Match every recorded spelling of this tree, not one string. Two rows naming
  // the same worktree differently are one tree, and missing that releases a tree
  // another conversation still owns.
  const spellings = worktreePathSpellings(database, row.worktree)
  if (!spellings.length) return []
  const candidates = database.query(
    `SELECT r.id, COALESCE(r.parent_run_id, r.id) AS root_id,
            r.status, ${EVIDENCE_CLOSED_SQL} AS scored
       FROM run r ${chainScoreJoin('r', 's')}
      WHERE r.worktree IN (${spellings.map(() => '?').join(',')})
        AND COALESCE(r.parent_run_id, r.id) <>
            COALESCE((SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?), ?)
        ${liveOnly ? "AND r.status IN ('running','asking')" : ''}
      ORDER BY r.id`,
  ).all(...spellings, row.id, row.id) as (WorktreeSharerRow & { root_id: number })[]
  const roots = new Set<number>()
  return candidates.flatMap((candidate) => {
    if (roots.has(candidate.root_id)) return []
    roots.add(candidate.root_id)
    return [{ ...candidate, id: candidate.root_id }]
  })
}

/** Other conversations alive on this tree now, collapsed to one row per root. */
export function liveWorktreeSharers(
  database: Database, row: { id: number; worktree: string },
): WorktreeSharerRow[] {
  return worktreeSharers(database, row, true)
}

/** Every other conversation that still points at this tree, collapsed to one row per root. */
export function otherConversationWorktreeSharers(
  database: Database, row: { id: number; worktree: string },
): WorktreeSharerRow[] {
  return worktreeSharers(database, row, false)
}

/** Liveness is any live row on the tree, including another turn in this conversation. */
export type TerminalDockerRetentionReason =
  | 'no recorded worktree'
  | 'unresolvable repository root'
  | 'live sharer present'
  | 'normalisation failed'
  | 'cleanup lease or lock unavailable'

type TerminalWorktreeSafety =
  | { safe: true; worktree: string; repoRoot: string }
  | { safe: false; reason: TerminalDockerRetentionReason }

export function worktreeIdentity(path: string): string {
  return withoutTrailingSeparators(realpathOrSpelled(path))
}

/**
 * Every recorded spelling of one worktree. run.worktree stores whatever the
 * caller spelled, so a trailing separator or an unresolved symlink makes two
 * rows for one tree; raw SQL equality then misses the other and releases a tree
 * whose other owner is still running. A bounded DISTINCT set keeps one notion
 * of tree ownership without normalising every run row.
 */
export function worktreePathSpellings(database: Database, worktree: string): string[] {
  const identity = worktreeIdentity(worktree)
  const rows = database.query(
    'SELECT DISTINCT worktree FROM run WHERE worktree IS NOT NULL',
  ).all() as { worktree: string }[]
  return rows.map((row) => row.worktree).filter((path) => {
    try { return worktreeIdentity(path) === identity } catch { return false }
  })
}

function terminalWorktreeSafety(
  database: Database, worktree: string | null,
): TerminalWorktreeSafety {
  if (!worktree) return { safe: false, reason: 'no recorded worktree' }
  let identity: string
  try { identity = worktreeIdentity(worktree) } catch {
    return { safe: false, reason: 'normalisation failed' }
  }
  let repoRoot: string | null
  try { repoRoot = repoRootOf(worktree) } catch {
    return { safe: false, reason: 'unresolvable repository root' }
  }
  if (!repoRoot) return { safe: false, reason: 'unresolvable repository root' }
  try {
    if (hasLiveWorktreeSharer(database, identity)) {
      return { safe: false, reason: 'live sharer present' }
    }
  } catch {
    return { safe: false, reason: 'normalisation failed' }
  }
  return { safe: true, worktree, repoRoot }
}

export function terminalDockerRetentionReason(
  database: Database, worktree: string | null,
): TerminalDockerRetentionReason | null {
  const safety = terminalWorktreeSafety(database, worktree)
  return safety.safe ? null : safety.reason
}

/** Explain why a surviving run-labelled resource was retained by a terminal turn in its chain. */
export function terminalDockerRetentionReasonForRun(
  database: Database, runId: number,
): TerminalDockerRetentionReason | null {
  const rows = database.query(
    `SELECT worktree FROM run
      WHERE COALESCE(parent_run_id, id) =
        (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)
        AND status IN ('ok','failed','stale','stopped')
      ORDER BY id DESC`,
  ).all(runId) as { worktree: string | null }[]
  for (const row of rows) {
    const reason = terminalDockerRetentionReason(database, row.worktree)
    if (reason) return reason
  }
  return null
}

export function hasLiveWorktreeSharer(database: Database, worktree: string): boolean {
  const identity = worktreeIdentity(worktree)
  const live = database.query(
    "SELECT worktree FROM run WHERE worktree IS NOT NULL AND status IN ('running','asking')",
  ).all() as { worktree: string }[]
  return live.some((row) => worktreeIdentity(row.worktree) === identity)
}

export type TerminalDockerTeardown = DockerTeardown & {
  outcome: 'removed' | 'live-sibling' | 'unascertainable' | 'nothing'
  reason: TerminalDockerRetentionReason | null
}

/** Best-effort container reclamation for every terminal transition in a conversation. */
export function teardownTerminalRunResources(database: Database, runId: number): TerminalDockerTeardown {
  const nothing = (): TerminalDockerTeardown => ({
    complete: true, errors: [], removed: 0, skipped: false, outcome: 'nothing', reason: null,
  })
  const row = database.query(
    'SELECT status, worktree FROM run WHERE id=?',
  ).get(runId) as { status: string; worktree: string | null } | null
  if (!row || !['ok', 'failed', 'stale', 'stopped'].includes(row.status)) return nothing()
  const initialSafety = terminalWorktreeSafety(database, row.worktree)
  if (!initialSafety.safe) return {
    ...nothing(), skipped: true,
    outcome: initialSafety.reason === 'live sharer present' ? 'live-sibling' : 'unascertainable',
    reason: initialSafety.reason,
  }
  const ids = database.query(
    `SELECT id FROM run WHERE COALESCE(parent_run_id, id) =
      (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)`,
  ).all(runId) as { id: number }[]
  const inventory = resourcesForRuns(ids.map(({ id }) => id), dockerRunResources())
  const failures = new Set(inventory.ascertainable ? [] : [inventory.reason])
  const containerRunIds = new Set(
    (inventory.ascertainable ? inventory.resources : []).filter((resource) => resource.kind === 'container')
      .map((resource) => resource.runId),
  )
  let removed = 0
  let skipped = false
  let retainedReason: TerminalDockerRetentionReason | null = null
  const remove = () => {
    for (const id of containerRunIds) {
      const result = teardownRunResources(
        id, inventory,
        () => terminalWorktreeSafety(database, row.worktree).safe,
      )
      removed += result.removed
      skipped ||= result.skipped
      if (result.skipped) {
        retainedReason = terminalDockerRetentionReason(database, row.worktree)
          ?? 'normalisation failed'
      }
      for (const error of result.errors) failures.add(error)
      if (skipped) break
    }
  }
  if (containerRunIds.size) {
    const identity = { session: sessionId(), what: `terminal Docker teardown for run ${runId}` }
    try {
      withWorktreeLease(initialSafety.repoRoot, initialSafety.worktree, identity, () => {
        withCleanupLock(initialSafety.repoRoot, identity, remove)
      })
    } catch (error) {
      failures.add(`Docker teardown unavailable: ${(error as Error).message}`)
      skipped = true
      retainedReason = 'cleanup lease or lock unavailable'
    }
  }
  if (!inventory.ascertainable) {
    console.error(`orch: ${inventory.reason}`)
  }
  if (failures.size) {
    try {
      const path = join(resolveRunsDirectory(DATABASE_RESOLUTION), String(runId), 'events.jsonl')
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify({
        ts: nowIso(), type: 'text', text: `Docker teardown incomplete: ${[...failures].join('; ')}`,
      })}\n`)
    } catch { /* teardown remains best-effort even when its durable trace cannot be written */ }
  }
  const finalRetentionReason: TerminalDockerRetentionReason | null = skipped
    ? retainedReason ?? terminalDockerRetentionReason(database, row.worktree) ?? 'normalisation failed'
    : null
  return {
    complete: failures.size === 0,
    errors: [...failures],
    removed,
    skipped,
    outcome: skipped
      ? finalRetentionReason === 'live sharer present'
        ? 'live-sibling'
        : 'unascertainable'
      : removed ? 'removed' : 'nothing',
    reason: finalRetentionReason,
  }
}

/** Runs this session made that nobody has judged. */
