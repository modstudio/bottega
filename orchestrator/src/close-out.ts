// concern: close-out
/**
 * Knows terminal outcome, branch uniqueness, worktree and resource ownership,
 * and reclamation. Must not know routing, contracts, transports, reviews, or
 * the CLI.
 */
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { db, nowIso, sessionId, writeTransaction } from './db.ts'
import { repoRootOf, targetGitEnvironment } from './git-environment.ts'
import { isGroupKillablePgid, runHasLiveDescendants } from './idle-kill.ts'
import { pidAlive } from './process-liveness.ts'
import {
  projectLockState,
  reclaimStaleProjectLock,
  withCleanupLock,
  withWorktreeLease,
  worktreeLeaseName,
} from './project-lock.ts'
import { projectAt, projectByName } from './projects.ts'
import { proveWorktreeReconstructible } from './reclaim.ts'
import {
  type ResourceClaimState,
  recordRetainedRefClaim,
  sandboxDirectoryRelease,
  settleClaims,
  settledStateForCloseOut,
} from './resource-claims.ts'
import { liveWorktreeSharers, worktreePathSpellings } from './resource-ownership.ts'
import { RUNS_DIR } from './run-artifacts.ts'
import { processTable, terminateRunProcesses } from './run-process.ts'
import { worktreeExists } from './worktree.ts'
import { inspectTreeOwnership } from './worktree-attribution.ts'
import { branchTip, removeFor, restoreBranch } from './worktree-remove.ts'
import type { Worktree } from './worktree-types.ts'

export type CloseOutResult = {
  runId: number
  worktree: string | null
  outcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
  detail: string
}

const TERMINAL = new Set(['ok', 'failed', 'stale', 'stopped'])

export type SandboxReleaseResult = {
  rootId: number
  path: string
  outcome: 'released' | 'absent' | 'kept'
  detail: string
}

function conversationProcessState(rootId: number): boolean | null {
  const inventory = processTable()
  if (!inventory.ascertainable) return null
  const turns = db()
    .query(
      `SELECT pid,agent_pid,agent_pgid FROM run
       WHERE id=? OR parent_run_id=? ORDER BY id`,
    )
    .all(rootId, rootId) as {
    pid: number | null
    agent_pid: number | null
    agent_pgid: number | null
  }[]
  const selfPgid = inventory.rows.find((row) => row.pid === process.pid)?.pgid ?? null
  const roots = [
    ...new Set(
      turns
        .flatMap((turn) => [turn.pid, turn.agent_pid])
        .filter((pid): pid is number => pid != null && pid > 1 && pid !== process.pid),
    ),
  ]
  const groups = new Set(
    turns
      .map((turn) => turn.agent_pgid)
      .filter(
        (pgid): pgid is number =>
          pgid != null && pgid > 1 && (selfPgid === null || pgid !== selfPgid),
      ),
  )
  const samples = inventory.rows.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    cpu: 0,
    state: '',
  }))
  return (
    runHasLiveDescendants(roots, [], { sample: () => samples }) ||
    inventory.rows.some((row) => roots.includes(row.pid) || groups.has(row.pgid))
  )
}

function recordedWorktreeState(rootId: number): ResourceClaimState | 'no-tree' {
  const claim = db()
    .query(
      `SELECT state FROM resource_claim
       WHERE root_run_id=? AND kind='worktree' ORDER BY id DESC LIMIT 1`,
    )
    .get(rootId) as { state: ResourceClaimState } | null
  if (claim) return claim.state
  const rows = db()
    .query('SELECT worktree FROM run WHERE id=? OR parent_run_id=?')
    .all(rootId, rootId) as { worktree: string | null }[]
  return rows.some((row) => row.worktree && existsSync(row.worktree)) ? 'claimed' : 'no-tree'
}

function pathInside(candidate: string | null, directory: string): boolean {
  if (!candidate) return false
  const path = resolve(candidate)
  const root = resolve(directory)
  return path === root || path.startsWith(`${root}/`)
}

/** Release one conversation's vendor home after its tree and process claims are settled. */
export function releaseSandboxDirectoryForConversation(
  rootId: number,
  options: { dryRun?: boolean; worktreeState?: ResourceClaimState | 'no-tree' } = {},
): SandboxReleaseResult {
  const path = join(RUNS_DIR, `sandbox-${rootId}`)
  const turns = db()
    .query('SELECT status,keep_tree FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
    .all(rootId, rootId) as { status: string; keep_tree: number }[]
  const decision = sandboxDirectoryRelease({
    terminal: turns.length > 0 && turns.every((turn) => TERMINAL.has(turn.status)),
    liveTurn: turns.some((turn) => turn.status === 'running' || turn.status === 'asking'),
    liveProcess: conversationProcessState(rootId),
    worktreeState: options.worktreeState ?? recordedWorktreeState(rootId),
    keepTree: turns.some((turn) => Boolean(turn.keep_tree)),
    directoryExists: existsSync(path),
  })
  if (decision === 'absent') {
    if (!options.dryRun)
      writeTransaction(() => {
        settleClaims(db(), {
          rootRunId: rootId,
          kind: 'sandbox_dir',
          state: 'absent',
          settledAt: nowIso(),
          detail: 'sandbox directory was already absent',
        })
      })
    return { rootId, path, outcome: 'absent', detail: 'sandbox directory was already absent' }
  }
  if (decision.startsWith('keep:')) {
    return { rootId, path, outcome: 'kept', detail: decision.slice('keep:'.length) }
  }
  if (options.dryRun) {
    return { rootId, path, outcome: 'released', detail: 'would release sandbox directory' }
  }
  try {
    rmSync(path, { recursive: true })
  } catch (error) {
    return {
      rootId,
      path,
      outcome: 'kept',
      detail: `sandbox directory removal failed: ${String((error as Error).message ?? error)}`,
    }
  }
  writeTransaction(() => {
    const settledAt = nowIso()
    settleClaims(db(), {
      rootRunId: rootId,
      kind: 'sandbox_dir',
      state: 'released',
      settledAt,
      detail: `removed ${path}`,
    })
    const trustClaims = db()
      .query(
        `SELECT allocation_key,identity FROM resource_claim
         WHERE root_run_id=? AND kind='trust_entry' AND state='claimed'`,
      )
      .all(rootId) as { allocation_key: string; identity: string | null }[]
    for (const claim of trustClaims) {
      if (!pathInside(claim.identity, path)) continue
      settleClaims(db(), {
        rootRunId: rootId,
        kind: 'trust_entry',
        state: 'released',
        settledAt,
        detail: `trust store removed with ${path}`,
        allocationKey: claim.allocation_key,
      })
    }
  })
  return { rootId, path, outcome: 'released', detail: `removed sandbox directory ${path}` }
}

function terminalHoldResult(
  runId: number,
  treePath: string,
  status: string,
  keepTree: number,
): CloseOutResult | null {
  if (!TERMINAL.has(status)) {
    return {
      runId,
      worktree: treePath,
      outcome: 'live',
      detail: `conversation is ${status}`,
    }
  }
  if (keepTree) {
    return {
      runId,
      worktree: treePath,
      outcome: 'held',
      detail: `held by explicit --keep-tree; clear with orch discard ${runId}`,
    }
  }
  return null
}

function ownershipCloseOutResult(input: {
  runId: number
  treePath: string
  repoRoot: string
  conversationIds: number[]
  branchTemplate?: string
  dryRun?: boolean
}): CloseOutResult | null {
  const ownership = inspectTreeOwnership(
    input.treePath,
    input.repoRoot,
    input.conversationIds,
    input.branchTemplate,
  )
  if (ownership === 'owned') return null
  if (ownership === 'unknown') {
    return {
      runId: input.runId,
      worktree: input.treePath,
      outcome: 'held',
      detail: `ownership of ${input.treePath} could not be established; pointer and tree retained`,
    }
  }
  if (!input.dryRun) {
    db()
      .query(
        `UPDATE run SET worktree=NULL
         WHERE worktree=? AND (id=? OR parent_run_id=?)`,
      )
      .run(input.treePath, input.runId, input.runId)
  }
  return {
    runId: input.runId,
    worktree: input.treePath,
    outcome: 'forgotten',
    detail: input.dryRun
      ? `would forget attached tree ${input.treePath}; tree and branch would be left in place`
      : `attached tree ${input.treePath} is not this run's; pointer cleared, tree left in place`,
  }
}

function absentCloseOutResult(input: {
  runId: number
  treePath: string
  repo: string | null
  cwd: string | null
  retainedBranch: string | null
  dryRun?: boolean
  recordRetainedBranch: (tip: string | null) => void
}): CloseOutResult | null {
  if (worktreeExists(input.treePath)) return null
  const repoRoot =
    (input.repo ? projectByName(input.repo)?.path : null) ?? repoRootOf(input.treePath) ?? input.cwd
  if (!input.dryRun && repoRoot && input.retainedBranch) {
    input.recordRetainedBranch(branchTip(repoRoot, input.retainedBranch))
  }
  return {
    runId: input.runId,
    worktree: input.treePath,
    outcome: 'absent',
    detail: 'worktree was already absent; recorded identity retained',
  }
}

/** One cleanup path for terminalisation, explicit close-out, and sweep. */
function attemptCloseOutRun(
  runId: number,
  options: {
    intent: 'terminal' | 'explicit' | 'sweep'
    dryRun?: boolean
    lockTimeoutMs?: number
    extraPids?: number[]
    pgid?: number | null
  },
): CloseOutResult {
  const row = db()
    .query(
      `SELECT id, COALESCE(parent_run_id,id) root_id, project_id, job, repo, cwd, worktree, branch,
            base_commit, worktree_source, minted_branch, keep_tree, status, agent_pid
       FROM run WHERE id=?`,
    )
    .get(runId) as {
    id: number
    root_id: number
    project_id: number | null
    job: string
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: Worktree['source'] | null
    minted_branch: string | null
    keep_tree: number
    status: string
    agent_pid: number | null
  } | null
  if (!row) throw new Error(`no run ${runId}`)
  const root = db()
    .query(
      `SELECT project_id,job,repo,cwd,worktree,branch,base_commit,worktree_source,minted_branch,keep_tree,status
       FROM run WHERE id=?`,
    )
    .get(row.root_id) as typeof row
  const treePath = row.worktree ?? root?.worktree ?? null
  if (!treePath)
    return { runId: row.root_id, worktree: null, outcome: 'absent', detail: 'no worktree' }
  const held = db()
    .query('SELECT MAX(keep_tree) held FROM run WHERE id=? OR parent_run_id=?')
    .get(row.root_id, row.root_id) as { held: number }
  const effective = {
    id: row.root_id,
    job: root?.job ?? row.job,
    repo: root?.repo ?? row.repo,
    cwd: root?.cwd ?? row.cwd,
    worktree: treePath,
    branch: root?.branch ?? row.branch,
    base_commit: root?.base_commit ?? row.base_commit,
    worktree_source: root?.worktree_source ?? row.worktree_source,
    minted_branch: root?.minted_branch ?? row.minted_branch,
    status: root?.status ?? row.status,
    keep_tree: held.held,
  }
  const terminalHold = terminalHoldResult(
    row.root_id,
    treePath,
    effective.status,
    effective.keep_tree,
  )
  if (terminalHold) return terminalHold
  const retainedBranch = effective.minted_branch ?? effective.branch
  const recordRetainedBranch = (tip: string | null, retainedRef?: string | null) => {
    if (!retainedBranch || !tip) return
    writeTransaction(() => {
      db()
        .query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
        .run(retainedBranch, tip, row.root_id)
      settleClaims(db(), {
        rootRunId: row.root_id,
        kind: 'branch',
        state: 'retained',
        settledAt: nowIso(),
        detail: `branch retained at ${tip}`,
        allocationKey: `refs/heads/${retainedBranch}`,
      })
      if (retainedRef) {
        recordRetainedRefClaim(db(), {
          rootRunId: row.root_id,
          runId: row.id,
          projectId: root?.project_id ?? row.project_id,
          ref: retainedRef,
          tip,
          claimedAt: nowIso(),
        })
      }
    })
  }
  const absentResult = absentCloseOutResult({
    runId: row.root_id,
    treePath,
    repo: effective.repo,
    cwd: effective.cwd,
    retainedBranch,
    dryRun: options.dryRun,
    recordRetainedBranch,
  })
  if (absentResult) return absentResult
  const repoRoot =
    (effective.repo ? projectByName(effective.repo)?.path : null) ??
    repoRootOf(treePath) ??
    effective.cwd
  if (!repoRoot)
    return {
      runId: row.root_id,
      worktree: treePath,
      outcome: 'failed',
      detail: 'repository root not found',
    }

  const conversationIds = (
    db()
      .query('SELECT id FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
      .all(row.root_id, row.root_id) as { id: number }[]
  ).map((turn) => turn.id)
  const branchTemplate = (effective.repo ? projectByName(effective.repo) : projectAt(treePath))
    ?.settings.worktree?.branch
  const ownershipResult = ownershipCloseOutResult({
    runId: row.root_id,
    treePath,
    repoRoot,
    conversationIds,
    branchTemplate,
    dryRun: options.dryRun,
  })
  if (ownershipResult) return ownershipResult

  const liveRows = () => {
    const sharers = liveWorktreeSharers(db(), { id: row.root_id, worktree: treePath })
    const conversation = db()
      .query(
        `SELECT id,status FROM run
        WHERE status IN ('running','asking') AND (id=? OR parent_run_id=?) ORDER BY id`,
      )
      .all(row.root_id, row.root_id) as { id: number; status: string }[]
    return [...conversation, ...sharers]
  }
  const live = liveRows()
  if (live.length)
    return {
      runId: row.root_id,
      worktree: treePath,
      outcome: 'live',
      detail: `live run(s): ${live.map((owner) => `${owner.id} (${owner.status})`).join(', ')}`,
    }
  // Every recorded spelling of this tree, not one string: a trailing separator
  // or an unresolved symlink makes two rows for one worktree, and matching only
  // the spelling in hand releases a tree whose other owner is still running.
  const spellings = worktreePathSpellings(db(), treePath)
  const vendorRows = spellings.length
    ? (db()
        .query(
          `SELECT agent_pid, agent_pgid FROM run
          WHERE worktree IN (${spellings.map(() => '?').join(',')}) ORDER BY id`,
        )
        .all(...spellings) as { agent_pid: number | null; agent_pgid: number | null }[])
    : []
  const agentPids = vendorRows.map((turn) => turn.agent_pid)
  const recordedPgids = [
    ...new Set(
      vendorRows
        .map((turn) => turn.agent_pgid)
        .filter((pgid): pgid is number => pgid != null && pgid > 1),
    ),
  ]
  const processInventory = processTable()
  if (!processInventory.ascertainable)
    return {
      runId: row.root_id,
      worktree: treePath,
      outcome: 'live',
      detail: `${processInventory.reason}; retained because process liveness could not be established`,
    }
  const processSamples = processInventory.rows.map((processRow) => ({
    pid: processRow.pid,
    ppid: processRow.ppid,
    pgid: processRow.pgid,
    cpu: 0,
    state: '',
  }))
  const sample = () => processSamples
  // The caller's own process group is never a vendor tree. A stub or CLI that
  // did not setsid inherits the coordinator pgid; after it exits that group
  // still has live members (this process). terminateProcessGroup already
  // refuses that pgid; close-out must too, or every finished run retains.
  const selfPgid = processSamples.find((row) => row.pid === process.pid)?.pgid ?? null
  const vendorGroupAlive = (pgid: number | null | undefined): boolean => {
    if (pgid == null || pgid <= 1) return false
    if (selfPgid !== null && !isGroupKillablePgid(pgid, selfPgid)) return false
    return runHasLiveDescendants([], [], { sample }, pgid)
  }
  // A database row cannot observe a grandchild born after the T0 census and
  // reparented when its wrapper died. Re-sample the process table and retain
  // the tree when the recorded vendor, a captured process group, or a
  // persisted vendor pgid still has a live member. Close-out does not signal
  // unverified leftovers; the monitor reports them.
  const treeStillAlive =
    runHasLiveDescendants(
      agentPids,
      options.extraPids ?? [],
      { sample },
      vendorGroupAlive(options.pgid) ? options.pgid : null,
    ) || recordedPgids.some((pgid) => vendorGroupAlive(pgid))
  if (treeStillAlive)
    return {
      runId: row.root_id,
      worktree: treePath,
      outcome: 'live',
      detail: 'process tree still alive',
    }
  const lease = worktreeLeaseName(treePath)
  reclaimStaleProjectLock(repoRoot, lease)
  const holder = projectLockState(repoRoot, lease).holder
  if (holder)
    return {
      runId: row.root_id,
      worktree: treePath,
      outcome: 'live',
      detail: `live worktree lease held by pid ${holder.pid}`,
    }

  try {
    return withWorktreeLease(
      repoRoot,
      treePath,
      { session: sessionId(), what: `close-out ${row.root_id}` },
      () =>
        withCleanupLock(
          repoRoot,
          { session: sessionId(), what: `close-out ${row.root_id}` },
          () => {
            const lockedLive = liveRows()
            if (lockedLive.length)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'live' as const,
                detail: `live run(s): ${lockedLive.map((owner) => `${owner.id} (${owner.status})`).join(', ')}`,
              }
            const reclaimProof = proveWorktreeReconstructible(treePath)
            if (!reclaimProof.ok)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'held' as const,
                detail: reclaimProof.action,
              }
            if (options.dryRun)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'released' as const,
                detail: 'would release clean terminal worktree and keep its branch',
              }
            // The coordinator proves its own identity before descendants are signalled.
            const liveCoordinator = (
              db()
                .query(
                  'SELECT id,pid FROM run WHERE (id=? OR parent_run_id=?) AND pid IS NOT NULL ORDER BY id',
                )
                .all(row.root_id, row.root_id) as { id: number; pid: number }[]
            ).find((turn) => turn.pid !== process.pid && pidAlive(turn.pid))
            if (liveCoordinator)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'live' as const,
                detail: `recorded coordinator pid ${liveCoordinator.pid} for run ${liveCoordinator.id} is still alive`,
              }
            terminateRunProcesses(row.id, [process.pid])
            const branchSnapshot = retainedBranch ? branchTip(repoRoot, retainedBranch) : null
            const retainedRef = branchSnapshot ? `refs/orch/retained/${row.root_id}` : null
            if (retainedRef && branchSnapshot) {
              const pinned = Bun.spawnSync(['git', 'update-ref', retainedRef, branchSnapshot], {
                cwd: repoRoot,
                env: targetGitEnvironment(repoRoot),
                stdout: 'pipe',
                stderr: 'pipe',
              })
              if (pinned.exitCode !== 0)
                return {
                  runId: row.root_id,
                  worktree: treePath,
                  outcome: 'failed' as const,
                  detail:
                    `could not protect retained branch ${retainedBranch} at ${branchSnapshot}: ` +
                    (pinned.stderr.toString().trim() || `git update-ref exited ${pinned.exitCode}`),
                }
            }
            // Publish the recovery identity before a project-owned remover runs: a
            // remover may delete or move the ref before reporting its refusal.
            recordRetainedBranch(branchSnapshot, retainedRef)
            const result = removeFor(
              {
                path: treePath,
                branch: effective.branch ?? '',
                base: effective.base_commit ?? '',
                repoRoot,
                source: effective.worktree_source ?? undefined,
                mintedBranch: effective.minted_branch,
              },
              repoRoot,
              false,
              true,
              row.root_id,
              false,
            )
            if (retainedBranch && branchSnapshot) {
              const branchAfter = branchTip(repoRoot, retainedBranch)
              if (branchAfter === null) {
                const restored = restoreBranch(repoRoot, retainedBranch, branchSnapshot)
                if (!restored.ok)
                  return {
                    runId: row.root_id,
                    worktree: treePath,
                    outcome: 'failed' as const,
                    detail:
                      `project remove tool deleted retained branch ${retainedBranch} at ${branchSnapshot}, ` +
                      `and restoration failed: ${restored.error}`,
                  }
              } else if (branchAfter !== branchSnapshot) {
                recordRetainedBranch(branchSnapshot)
                return {
                  runId: row.root_id,
                  worktree: treePath,
                  outcome: 'failed' as const,
                  detail:
                    `project remove tool moved unique branch ${retainedBranch} from ` +
                    `${branchSnapshot} to ${branchAfter}; it was left at the new tip`,
                }
              }
            }
            if (retainedRef) {
              const unpinned = Bun.spawnSync(
                ['git', 'update-ref', '-d', retainedRef, branchSnapshot!],
                {
                  cwd: repoRoot,
                  env: targetGitEnvironment(repoRoot),
                  stdout: 'pipe',
                  stderr: 'pipe',
                },
              )
              if (unpinned.exitCode !== 0)
                return {
                  runId: row.root_id,
                  worktree: treePath,
                  outcome: 'failed' as const,
                  detail:
                    `retained branch ${retainedBranch} was verified, but ${retainedRef} could not be removed: ` +
                    (unpinned.stderr.toString().trim() ||
                      `git update-ref exited ${unpinned.exitCode}`),
                }
              writeTransaction(() => {
                settleClaims(db(), {
                  rootRunId: row.root_id,
                  kind: 'retained_ref',
                  state: 'released',
                  settledAt: nowIso(),
                  detail: `deleted ${retainedRef}`,
                  allocationKey: retainedRef,
                })
              })
            }
            if (!result.removed)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'failed' as const,
                detail: result.detail,
              }
            const acquired = liveRows()
            if (acquired.length) {
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'failed' as const,
                detail:
                  `worktree was acquired during cleanup by run(s): ` +
                  acquired.map((owner) => `${owner.id} (${owner.status})`).join(', '),
              }
            }
            return {
              runId: row.root_id,
              worktree: treePath,
              outcome: 'released' as const,
              detail: result.output ? `${result.detail}\n${result.output}` : result.detail,
            }
          },
          options.lockTimeoutMs,
        ),
      options.lockTimeoutMs,
    )
  } catch (error) {
    return {
      runId: row.root_id,
      worktree: treePath,
      outcome: 'failed',
      detail: String((error as Error).message ?? error),
    }
  }
}

/** Run one close-out attempt and retain its outcome for observation and retry. */
export function closeOutRun(
  runId: number,
  options: {
    intent: 'terminal' | 'explicit' | 'sweep'
    dryRun?: boolean
    lockTimeoutMs?: number
    extraPids?: number[]
    pgid?: number | null
  },
): CloseOutResult {
  const result = attemptCloseOutRun(runId, options)
  if (!options.dryRun) {
    writeTransaction(() => {
      const settled = settledStateForCloseOut(result.outcome, 'worktree')
      const settledAt = nowIso()
      db()
        .query(
          `UPDATE run
            SET close_out_outcome=?, close_out_detail=?, close_out_attempted_at=?
          WHERE id=?`,
        )
        .run(result.outcome, result.detail, settledAt, result.runId)
      if (settled && settled !== 'claimed') {
        settleClaims(db(), {
          rootRunId: result.runId,
          kind: 'worktree',
          state: settled,
          settledAt,
          detail: result.detail,
        })
      }
    })
  }
  if (options.intent !== 'sweep' && ['released', 'absent', 'forgotten'].includes(result.outcome)) {
    const sandbox = releaseSandboxDirectoryForConversation(result.runId, {
      dryRun: options.dryRun,
      worktreeState: result.outcome as Extract<
        ResourceClaimState,
        'released' | 'absent' | 'forgotten'
      >,
    })
    if (sandbox.outcome === 'kept' || sandbox.outcome === 'released') {
      result.detail = `${result.detail}; ${sandbox.detail}`
      if (!options.dryRun) {
        db().query('UPDATE run SET close_out_detail=? WHERE id=?').run(result.detail, result.runId)
      }
    }
  }
  return result
}

export function reclaimTerminalTree(
  runId: number,
  worktree: Worktree,
  extraPids: number[] = [],
  pgid: number | null = null,
): void {
  try {
    const result = closeOutRun(runId, { intent: 'terminal', extraPids, pgid })
    if (result.outcome !== 'released' && result.outcome !== 'absent') {
      console.error(`orch: close-out ${result.outcome} worktree for run ${runId}: ${result.detail}`)
    }
  } catch (e) {
    console.error(`orch: could not reclaim worktree for run ${runId}: ${e}`)
  }
}
