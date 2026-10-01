// concern: resource-ownership
/**
 * Knows worktree claims, live sharing, and terminal resource teardown. Must not know routing, transports, reviews, contracts, or CLI adapters.
 */
import type { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { nowIso, sessionId } from '../database/db.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from '../evidence/evidence-query.ts'
import { realpathOrSpelled, withoutTrailingSeparators } from '../git/checkout-identity.ts'
import { repoRootOf } from '../git/git-environment.ts'
import { withCleanupLock, withWorktreeLease } from '../project/project-lock.ts'
import { runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import {
  type DockerInventory,
  type DockerResource,
  type DockerTeardown,
  dockerRunResources,
  resourcesForRuns,
  teardownRunResources,
} from './docker-resources.ts'
import {
  decideTerminalDockerInventory,
  decideWorktreeResourceTeardown,
} from './main-stack-decision.ts'

export type WorktreeSharerRow = { id: number; status: string; scored: number }

function worktreeSharers(
  database: Database,
  row: { id: number; worktree: string },
  liveOnly: boolean,
): WorktreeSharerRow[] {
  // Match every recorded spelling of this tree, not one string. Two rows naming
  // the same worktree differently are one tree, and missing that releases a tree
  // another conversation still owns.
  const spellings = worktreePathSpellings(database, row.worktree)
  if (!spellings.length) return []
  const candidates = database
    .query(
      `SELECT r.id, COALESCE(r.parent_run_id, r.id) AS root_id,
            r.status, r.pid, ${EVIDENCE_CLOSED_SQL} AS scored
       FROM run r ${chainScoreJoin('r', 's')}
      WHERE r.worktree IN (${spellings.map(() => '?').join(',')})
        AND COALESCE(r.parent_run_id, r.id) <>
            COALESCE((SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?), ?)
        ${liveOnly ? "AND r.status IN ('running','asking')" : ''}
      ORDER BY r.id`,
    )
    .all(...spellings, row.id, row.id) as (WorktreeSharerRow & {
    root_id: number
    pid: number | null
  })[]
  const roots = new Set<number>()
  return candidates.flatMap((candidate) => {
    if (
      liveOnly &&
      !runAlive({
        status: candidate.status,
        lease: runLeaseState(candidate.id),
        pidAlive: Boolean(candidate.pid && pidAlive(candidate.pid)),
      })
    )
      return []
    if (roots.has(candidate.root_id)) return []
    roots.add(candidate.root_id)
    return [{ ...candidate, id: candidate.root_id }]
  })
}

/** Other conversations alive on this tree now, collapsed to one row per root. */
export function liveWorktreeSharers(
  database: Database,
  row: { id: number; worktree: string },
): WorktreeSharerRow[] {
  return worktreeSharers(database, row, true)
}

/** Every other conversation that still points at this tree, collapsed to one row per root. */
export function otherConversationWorktreeSharers(
  database: Database,
  row: { id: number; worktree: string },
): WorktreeSharerRow[] {
  return worktreeSharers(database, row, false)
}

/** Liveness is any live row on the tree, including another turn in this conversation. */
export type TerminalDockerRetentionReason =
  | 'no recorded worktree'
  | 'unresolvable repository root'
  | 'live sharer present'
  | 'normalization failed'
  | 'cleanup lease or lock unavailable'

type TerminalWorktreeSafety =
  | { safe: true; worktree: string | null; repoRoot: string | null }
  | { safe: false; reason: TerminalDockerRetentionReason }

function worktreeIdentity(path: string): string {
  return withoutTrailingSeparators(realpathOrSpelled(path))
}

/**
 * Every recorded spelling of one worktree. run.worktree stores whatever the
 * caller spelled, so a trailing separator or an unresolved symlink makes two
 * rows for one tree; raw SQL equality then misses the other and releases a tree
 * whose other owner is still running. A bounded DISTINCT set keeps one notion
 * of tree ownership without normalizing every run row.
 */
export function worktreePathSpellings(database: Database, worktree: string): string[] {
  const identity = worktreeIdentity(worktree)
  const rows = database
    .query('SELECT DISTINCT worktree FROM run WHERE worktree IS NOT NULL')
    .all() as { worktree: string }[]
  return rows
    .map((row) => row.worktree)
    .filter((path) => {
      try {
        return worktreeIdentity(path) === identity
      } catch {
        return false
      }
    })
}

function terminalWorktreeSafety(
  database: Database,
  row: { worktree: string | null; repo: string | null; cwd: string | null },
): TerminalWorktreeSafety {
  const { worktree } = row
  let identity: string | null = null
  if (worktree) {
    try {
      identity = worktreeIdentity(worktree)
    } catch {
      return { safe: false, reason: 'normalization failed' }
    }
  }
  let repoRoot: string | null
  try {
    const registered = row.repo
      ? (database.query('SELECT path FROM project WHERE name=?').get(row.repo) as {
          path: string
        } | null)
      : null
    repoRoot = registered?.path ?? (worktree ? repoRootOf(worktree) : null) ?? row.cwd
  } catch {
    return { safe: false, reason: 'unresolvable repository root' }
  }
  try {
    if (identity && hasLiveWorktreeSharer(database, identity)) {
      return { safe: false, reason: 'live sharer present' }
    }
  } catch {
    return { safe: false, reason: 'normalization failed' }
  }
  return { safe: true, worktree, repoRoot }
}

function terminalDockerRetentionReason(
  database: Database,
  row: { worktree: string | null; repo: string | null; cwd: string | null },
): TerminalDockerRetentionReason | null {
  const safety = terminalWorktreeSafety(database, row)
  return safety.safe ? null : safety.reason
}

/** Explain why a surviving run-labeled resource was retained by a terminal turn in its chain. */
export function terminalDockerRetentionReasonForRun(
  database: Database,
  runId: number,
): TerminalDockerRetentionReason | null {
  const rows = database
    .query(
      `SELECT worktree,repo,cwd FROM run
      WHERE COALESCE(parent_run_id, id) =
        (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)
        AND status IN ('ok','failed','stale','stopped')
      ORDER BY id DESC`,
    )
    .all(runId) as { worktree: string | null; repo: string | null; cwd: string | null }[]
  for (const row of rows) {
    const reason = terminalDockerRetentionReason(database, row)
    if (reason) return reason
  }
  return null
}

function hasLiveWorktreeSharer(database: Database, worktree: string): boolean {
  const identity = worktreeIdentity(worktree)
  const live = database
    .query(
      "SELECT id,status,pid,worktree FROM run WHERE worktree IS NOT NULL AND status IN ('running','asking')",
    )
    .all() as { id: number; status: string; pid: number | null; worktree: string }[]
  return live.some(
    (row) =>
      runAlive({
        status: row.status,
        lease: runLeaseState(row.id),
        pidAlive: Boolean(row.pid && pidAlive(row.pid)),
      }) && worktreeIdentity(row.worktree) === identity,
  )
}

export type TerminalDockerTeardown = DockerTeardown & {
  outcome: 'removed' | 'live-sibling' | 'unascertainable' | 'nothing'
  reason: TerminalDockerRetentionReason | null
}

type TerminalRunRow = {
  status: string
  worktree: string | null
  repo: string | null
  cwd: string | null
}

type TerminalDockerRemovalResult = {
  failures: Set<string>
  removed: number
  skipped: boolean
  reason: TerminalDockerRetentionReason | null
}

function chainHasLiveRun(database: Database, runId: number): boolean {
  const candidates = database
    .query(
      `SELECT id,status,pid FROM run WHERE COALESCE(parent_run_id,id)=
       (SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)
       AND status IN ('running','asking')`,
    )
    .all(runId) as { id: number; status: string; pid: number | null }[]
  return candidates.some((candidate) =>
    runAlive({
      status: candidate.status,
      lease: runLeaseState(candidate.id),
      pidAlive: Boolean(candidate.pid && pidAlive(candidate.pid)),
    }),
  )
}

function removeTerminalDockerResources(input: {
  database: Database
  inventory: ReturnType<typeof resourcesForRuns>
  resourceRunIds: Set<number>
  row: TerminalRunRow
  chainLive: boolean
  dryRun: boolean
}): TerminalDockerRemovalResult {
  const { database, inventory, resourceRunIds, row, chainLive, dryRun } = input
  const failures = new Set(inventory.ascertainable ? [] : [inventory.reason])
  let removed = 0
  const skipped = false
  const reason: TerminalDockerRetentionReason | null = null
  for (const id of resourceRunIds) {
    const result = removeTerminalDockerResourceGroup({
      database,
      inventory,
      id,
      row,
      chainLive,
      dryRun,
      failures,
      removed,
    })
    removed += result.removed
    for (const error of result.errors) failures.add(error)
    if (result.retained) return result.retained
  }
  return { failures, removed, skipped, reason }
}

function removeTerminalDockerResourceGroup(input: {
  database: Database
  inventory: ReturnType<typeof resourcesForRuns>
  id: number
  row: TerminalRunRow
  chainLive: boolean
  dryRun: boolean
  failures: Set<string>
  removed: number
}): { removed: number; errors: string[]; retained: TerminalDockerRemovalResult | null } {
  const owned = input.inventory.ascertainable
    ? input.inventory.resources.filter((resource) => resource.runId === input.id)
    : []
  if (!terminalResourcesEligible(owned, input.chainLive, input.row.worktree))
    return {
      removed: 0,
      errors: [],
      retained: {
        failures: input.failures,
        removed: input.removed,
        skipped: true,
        reason: input.chainLive ? 'live sharer present' : 'normalization failed',
      },
    }
  if (input.dryRun)
    return {
      removed: owned.length,
      errors: [],
      retained: previewRetention(input.database, input.row, input.failures, input.removed),
    }
  const result = teardownRunResources(
    input.id,
    input.inventory,
    () => terminalWorktreeSafety(input.database, input.row).safe,
  )
  return {
    removed: result.removed,
    errors: result.errors,
    retained: result.skipped
      ? {
          failures: input.failures,
          removed: input.removed + result.removed,
          skipped: true,
          reason:
            terminalDockerRetentionReason(input.database, input.row) ?? 'normalization failed',
        }
      : null,
  }
}

function terminalResourcesEligible(
  resources: DockerResource[],
  chainLive: boolean,
  worktree: string | null,
): boolean {
  return resources.every(
    (resource) =>
      decideWorktreeResourceTeardown({
        attributable: true,
        mainCheckout: resource.mainCheckout === true,
        liveRun: chainLive,
        terminalRun: true,
        treeAbsent: !worktree || !existsSync(worktree),
      }) === 'remove',
  )
}

function previewRetention(
  database: Database,
  row: TerminalRunRow,
  failures: Set<string>,
  removed: number,
): TerminalDockerRemovalResult | null {
  if (terminalWorktreeSafety(database, row).safe) return null
  return {
    failures,
    removed,
    skipped: true,
    reason: terminalDockerRetentionReason(database, row) ?? 'normalization failed',
  }
}

function underTerminalCleanupLock(
  safety: Extract<TerminalWorktreeSafety, { safe: true }>,
  runId: number,
  remove: () => void,
): void {
  const identity = { session: sessionId(), what: `terminal Docker teardown for run ${runId}` }
  if (!safety.repoRoot) {
    remove()
    return
  }
  if (!safety.worktree || !existsSync(safety.worktree)) {
    withCleanupLock(safety.repoRoot, identity, remove)
    return
  }
  withWorktreeLease(safety.repoRoot, safety.worktree, identity, () => {
    withCleanupLock(safety.repoRoot!, identity, remove)
  })
}

function terminalDockerInventory(
  database: Database,
  ids: { id: number }[],
  suppliedInventory?: DockerInventory,
): DockerInventory {
  const inventory =
    suppliedInventory ??
    dockerRunResources(
      (
        database.query('SELECT path FROM project WHERE retired_at IS NULL').all() as {
          path: string
        }[]
      ).map(({ path }) => path),
    )
  return resourcesForRuns(
    ids.map(({ id }) => id),
    inventory,
  )
}

function terminalTeardownTarget(
  database: Database,
  runId: number,
  inventorySupplied: boolean,
): { row: TerminalRunRow; ids: { id: number; worktree: string | null }[] } | null {
  const row = database
    .query('SELECT status, worktree,repo,cwd FROM run WHERE id=?')
    .get(runId) as TerminalRunRow | null
  if (!row || !['ok', 'failed', 'stale', 'stopped'].includes(row.status)) return null
  const ids = database
    .query(
      `SELECT id,worktree FROM run WHERE COALESCE(parent_run_id, id) =
      (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)`,
    )
    .all(runId) as { id: number; worktree: string | null }[]
  const inventoryDecision = decideTerminalDockerInventory({
    inventorySupplied,
    chainHasRecordedWorktree: ids.some(({ worktree }) => worktree !== null),
  })
  return inventoryDecision === 'skip' ? null : { row, ids }
}

/** Best-effort container reclamation for every terminal transition in a conversation. */
export function teardownTerminalRunResources(
  database: Database,
  runId: number,
  suppliedInventory?: DockerInventory,
  options: { dryRun?: boolean } = {},
): TerminalDockerTeardown {
  const nothing = (): TerminalDockerTeardown => ({
    complete: true,
    errors: [],
    removed: 0,
    skipped: false,
    outcome: 'nothing',
    reason: null,
  })
  const target = terminalTeardownTarget(database, runId, suppliedInventory !== undefined)
  if (!target) return nothing()
  const { ids, row } = target
  const initialSafety = terminalWorktreeSafety(database, row)
  if (!initialSafety.safe)
    return {
      ...nothing(),
      skipped: true,
      outcome: initialSafety.reason === 'live sharer present' ? 'live-sibling' : 'unascertainable',
      reason: initialSafety.reason,
    }
  const inventory = terminalDockerInventory(database, ids, suppliedInventory)
  const resourceRunIds = new Set(
    (inventory.ascertainable ? inventory.resources : []).map((resource) => resource.runId),
  )
  let result: TerminalDockerRemovalResult = {
    failures: new Set(inventory.ascertainable ? [] : [inventory.reason]),
    removed: 0,
    skipped: false,
    reason: null as TerminalDockerRetentionReason | null,
  }
  if (resourceRunIds.size)
    result = executeTerminalDockerRemoval({
      database,
      inventory,
      resourceRunIds,
      row,
      runId,
      initialSafety,
      dryRun: options.dryRun === true,
    })
  if (!inventory.ascertainable) {
    console.error(`orch: ${inventory.reason}`)
  }
  if (result.failures.size) {
    try {
      const path = join(resolveRunsDirectory(process.env), String(runId), 'events.jsonl')
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(
        path,
        `${JSON.stringify({
          ts: nowIso(),
          type: 'text',
          text: `Docker teardown incomplete: ${[...result.failures].join('; ')}`,
        })}\n`,
      )
    } catch {
      /* teardown remains best-effort even when its durable trace cannot be written */
    }
  }
  const finalRetentionReason: TerminalDockerRetentionReason | null = result.skipped
    ? (result.reason ?? terminalDockerRetentionReason(database, row) ?? 'normalization failed')
    : null
  return {
    complete: result.failures.size === 0,
    errors: [...result.failures],
    removed: result.removed,
    skipped: result.skipped,
    outcome: result.skipped
      ? finalRetentionReason === 'live sharer present'
        ? 'live-sibling'
        : 'unascertainable'
      : result.removed
        ? 'removed'
        : 'nothing',
    reason: finalRetentionReason,
  }
}

function executeTerminalDockerRemoval(input: {
  database: Database
  inventory: ReturnType<typeof resourcesForRuns>
  resourceRunIds: Set<number>
  row: TerminalRunRow
  runId: number
  initialSafety: Extract<TerminalWorktreeSafety, { safe: true }>
  dryRun: boolean
}): TerminalDockerRemovalResult {
  let result: TerminalDockerRemovalResult = {
    failures: new Set(input.inventory.ascertainable ? [] : [input.inventory.reason]),
    removed: 0,
    skipped: false,
    reason: null,
  }
  try {
    const remove = () => {
      result = removeTerminalDockerResources({
        database: input.database,
        inventory: input.inventory,
        resourceRunIds: input.resourceRunIds,
        row: input.row,
        chainLive: chainHasLiveRun(input.database, input.runId),
        dryRun: input.dryRun,
      })
    }
    if (input.dryRun) remove()
    else underTerminalCleanupLock(input.initialSafety, input.runId, remove)
  } catch (error) {
    result.failures.add(`Docker teardown unavailable: ${(error as Error).message}`)
    result.skipped = true
    result.reason = 'cleanup lease or lock unavailable'
  }
  return result
}

/** Runs this session made that nobody has judged. */
