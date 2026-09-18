/** Run stop knows run terminal writes, worktree ownership, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */

import {
  type CleanupOptions,
  type CleanupRow,
  cleanupRepoRoot,
  discardWorktree,
  evidenceOwningBranchOwners,
  verifyBranchOwnershipAfterCleanup,
  withCleanupLock,
} from '../cleanup/cleanup.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import { branchTip, removeBranch, unmergedBranch } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { adoptRunMutation, auditRunMutation, authorizeRunMutation } from './run-authority.ts'
import { resolveRootFromLastTurn } from './run-liveness.ts'

export type RunStopOptions = CleanupOptions & { note?: string }
export type RunStopHelpers = {
  lifecycleCheckpoint: (name: string) => void
  terminateRunProcesses: (runId: number, exceptPids?: number[]) => void
}

export async function stopRun(
  id: number,
  options: RunStopOptions,
  helpers: RunStopHelpers,
): Promise<void> {
  let authority = authorizeRunMutation(id, 'stop')
  helpers.lifecycleCheckpoint('stop-before-immediate')
  type StopRow = {
    id: number
    status: string
    pid: number | null
    agent_pid: number | null
    parent_run_id: number | null
    turn: number
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: Worktree['source'] | null
  }
  const readChain = () =>
    db()
      .query(
        `SELECT id, status, pid, agent_pid, parent_run_id, turn, repo, cwd, worktree, branch,
              base_commit, worktree_source
         FROM run WHERE id = ? OR parent_run_id = ? ORDER BY turn DESC, id DESC`,
      )
      .all(authority.rootId, authority.rootId) as StopRow[]
  const describe = (chain: StopRow[]) =>
    [...chain]
      .reverse()
      .map((turn) => `${turn.id} turn ${turn.turn} ${turn.status}`)
      .join('; ')

  const stopped = writeTransaction(() => {
    const chain = readChain()
    const row = chain.find((turn) => turn.status === 'running')
    if (!row) {
      throw new Error(`run ${id}'s chain has no running turn — nothing to stop: ${describe(chain)}`)
    }
    const root = chain.find((turn) => turn.id === authority.rootId)!
    const artifact = chain.find((turn) => turn.worktree)
    const cleanupRow = {
      ...root,
      worktree: row.worktree ?? artifact?.worktree ?? null,
      branch: root.branch ?? row.branch ?? artifact?.branch ?? null,
      base_commit: root.base_commit ?? row.base_commit ?? artifact?.base_commit ?? null,
      worktree_source:
        root.worktree_source ?? row.worktree_source ?? artifact?.worktree_source ?? null,
    }

    authority = adoptRunMutation(authority, 'stop')
    const changed = db()
      .query(
        "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped' WHERE id=? AND status='running'",
      )
      .run(row.id)
    if (changed.changes !== 1) {
      const current = readChain()
      throw new Error(`run ${id}'s chain changed before it could be stopped: ${describe(current)}`)
    }
    if (row.id !== authority.rootId) {
      db()
        .query(
          "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped' WHERE id=?",
        )
        .run(authority.rootId)
    }
    db()
      .query(
        `UPDATE question SET delivery_pending_at=NULL
          WHERE run_id IN (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      )
      .run(authority.rootId, authority.rootId)
    auditRunMutation(authority, 'stop', options.auditReason)
    return { row, cleanupRow }
  })
  const { row, cleanupRow } = stopped

  const pids = [...new Set([row.agent_pid, row.pid].filter((pid): pid is number => Boolean(pid)))]
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    }
  }

  // The coordinator owns setup and final recording. Killing it inside the
  // creation window strands the project tool's directory before it can be
  // attributed or reclaimed. Stop the vendor, but let the coordinator see
  // the stopped row and finish recording. The tree remains the continuation
  // substrate; only its recreatable containers are reclaimed at stop.
  helpers.terminateRunProcesses(row.id, row.pid ? [row.pid] : [])
  const dockerTeardown = teardownTerminalRunResources(db(), row.id)
  options.presentation.log(`stopped run ${row.id}`)
  if (cleanupRow.worktree) {
    const dockerMessage = !dockerTeardown.complete
      ? dockerTeardown.removed
        ? 'reclaimed Docker containers, but reclamation was incomplete'
        : 'Docker container reclamation was incomplete'
      : dockerTeardown.outcome === 'removed'
        ? 'reclaimed Docker containers'
        : dockerTeardown.outcome === 'live-sibling'
          ? 'left Docker containers in place because another live run still owns the tree'
          : dockerTeardown.outcome === 'unascertainable'
            ? `left Docker containers in place because removal could not be ascertained: ${dockerTeardown.reason}`
            : 'found no Docker containers to reclaim'
    options.presentation.log(
      `kept worktree ${cleanupRow.worktree} and branch ${cleanupRow.branch ?? '(unknown)'} for continuation; ` +
        dockerMessage,
    )
  } else if (dockerTeardown.outcome === 'unascertainable') {
    options.presentation.log(
      `left Docker containers in place because removal could not be ascertained: ${dockerTeardown.reason}`,
    )
  }
  return
}

export async function abandonRun(
  id: number,
  options: RunStopOptions,
  helpers: RunStopHelpers,
): Promise<void> {
  let authority = authorizeRunMutation(id, 'abandon')
  helpers.lifecycleCheckpoint('abandon-before-immediate')
  type AbandonRow = {
    id: number
    status: string
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    parent_run_id: number | null
    turn: number
    base_commit: string | null
    worktree_source: Worktree['source'] | null
  }
  const callerSession = authority.actor
  const note = options.note
  const error = `abandoned by architect${note === undefined ? '' : `: ${note}`}`
  const at = nowIso()
  const readChain = () =>
    db()
      .query(
        `SELECT id, status, repo, cwd, worktree, branch, parent_run_id, turn, base_commit,
              worktree_source
         FROM run WHERE id = ? OR parent_run_id = ? ORDER BY turn DESC, id DESC`,
      )
      .all(authority.rootId, authority.rootId) as AbandonRow[]
  const describe = (chain: AbandonRow[]) =>
    [...chain]
      .reverse()
      .map((turn) => `${turn.id} turn ${turn.turn} ${turn.status}`)
      .join('; ')

  const abandoned = writeTransaction(() => {
    const chain = readChain()
    const row = chain[0]
    if (row?.status !== 'asking') {
      const remedy =
        row?.status === 'running'
          ? `; run orch stop ${id} to stop its running turn`
          : row
            ? `; the latest turn is already terminal (${row.status}), so no lifecycle verb applies`
            : '; no lifecycle verb applies to an empty chain'
      throw new Error(
        `run ${id}'s chain has no asking turn — nothing to abandon${remedy}: ${describe(chain)}`,
      )
    }
    const root = chain.find((turn) => turn.id === authority.rootId)!
    const artifact = chain.find((turn) => turn.worktree)
    const cleanupRow = {
      ...root,
      worktree: row.worktree ?? artifact?.worktree ?? null,
      branch: root.branch ?? row.branch ?? artifact?.branch ?? null,
      base_commit: root.base_commit ?? row.base_commit ?? artifact?.base_commit ?? null,
      worktree_source:
        root.worktree_source ?? row.worktree_source ?? artifact?.worktree_source ?? null,
    }
    authority = adoptRunMutation(authority, 'abandon')
    const changed = db()
      .query(
        "UPDATE run SET status='stale', error=?, failure_kind='abandoned' WHERE id=? AND status='asking'",
      )
      .run(error, row.id)
    if (changed.changes !== 1) {
      const current = readChain()
      throw new Error(
        `run ${id}'s chain changed before it could be abandoned: ${describe(current)}`,
      )
    }
    db()
      .query(
        `UPDATE question SET answered_by=?, answered_at=?, answer='(abandoned)', delivery_pending_at=NULL
          WHERE answered_at IS NULL AND run_id IN
            (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      )
      .run(callerSession ?? 'anonymous (no session id)', at, authority.rootId, authority.rootId)
    db()
      .query(
        `UPDATE question SET delivery_pending_at=NULL
          WHERE run_id IN (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      )
      .run(authority.rootId, authority.rootId)
    resolveRootFromLastTurn(db(), authority.rootId)
    auditRunMutation(authority, 'abandon', note ?? null)
    return { row, cleanupRow }
  })
  const { row, cleanupRow } = abandoned
  teardownTerminalRunResources(db(), row.id)
  options.presentation.log(`abandoned run ${row.id}`)

  if (cleanupRow.worktree) {
    await discardWorktree(cleanupRow as CleanupRow, 'abandoned', options.force, undefined, options)
    return
  }

  options.presentation.log(`worktree cleanup skipped: run ${id} has no worktree`)
  if (!cleanupRow.branch) {
    options.presentation.log(`branch cleanup skipped: run ${id} has no branch`)
    return
  }

  const repoRoot = cleanupRepoRoot(cleanupRow)
  if (!repoRoot) {
    options.presentation.log(
      `branch ${cleanupRow.branch} cleanup skipped: repository root not found`,
    )
    return
  }
  withCleanupLock(repoRoot, `abandon run ${id}`, cleanupRow.worktree, () => {
    const ownersBefore = evidenceOwningBranchOwners(cleanupRow, repoRoot)
    if (ownersBefore.length) {
      options.presentation.log(
        `branch ${cleanupRow.branch} left because run ${ownersBefore[0]!.id} records it`,
      )
      return
    }
    let protectedBranch: ReturnType<typeof unmergedBranch> = null
    let afterCutCount: number | null = null
    if (!options.force) {
      protectedBranch = unmergedBranch(repoRoot, cleanupRow.branch!, null)
      afterCutCount = cleanupRow.base_commit
        ? (unmergedBranch(repoRoot, cleanupRow.branch!, cleanupRow.base_commit)?.count ?? 0)
        : null
    }
    if (protectedBranch) {
      db()
        .query('UPDATE run SET branch_kept=?, branch_kept_tip=NULL WHERE id=?')
        .run(cleanupRow.branch, authority.rootId)
      options.presentation.log(
        options.presentation.keptBranchLine(
          cleanupRow.branch!,
          protectedBranch.count,
          afterCutCount,
          authority.rootId,
        ),
      )
      return
    }
    const snapshot = branchTip(repoRoot, cleanupRow.branch!)
    const removed = removeBranch(repoRoot, cleanupRow.branch!)
    const ownersAfter = evidenceOwningBranchOwners(cleanupRow, repoRoot, snapshot)
    const outcome = verifyBranchOwnershipAfterCleanup(
      cleanupRow.id,
      repoRoot,
      cleanupRow.branch!,
      snapshot,
      ownersBefore,
      ownersAfter,
    )
    if (outcome.refusal) throw new Error(outcome.refusal)
    if (outcome.warning) options.presentation.error(outcome.warning)
    options.presentation.log(
      removed
        ? `deleted branch ${cleanupRow.branch}`
        : `branch ${cleanupRow.branch} cleanup skipped: branch does not exist`,
    )
  })
  return
}
