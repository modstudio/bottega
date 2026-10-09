// concern: close-out
/**
 * Knows terminal outcome, branch uniqueness, worktree and resource ownership,
 * and reclamation. Must not know routing, contracts, transports, reviews, or
 * the CLI.
 */
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { gitContext, restoreBranch, targetGitEnvironment } from '../git/git-environment.ts'
import { hookTreeHoldDecision } from '../hook-tree/hook-tree.ts'
import { isGroupKillablePgid, runHasLiveDescendants } from '../idle-kill.ts'
import { landingTreeHoldDecision } from '../landing-tree/landing-tree.ts'
import {
  projectLockState,
  reclaimStaleProjectLock,
  withCleanupLock,
  withWorktreeLease,
  worktreeLeaseName,
} from '../project/project-lock.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  type ResourceClaimState,
  recordRetainedRefClaim,
  sandboxDirectoryRelease,
  settleClaims,
  settledStateForCloseOut,
} from '../resources/resource-claims.ts'
import {
  liveWorktreeSharers,
  otherConversationWorktreeSharers,
  worktreePathSpellings,
} from '../resources/resource-ownership.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import { removeFreeRunLease } from '../run/run-lease.ts'
import { processTable, terminateRunProcesses } from '../run/run-process.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import { keepTreeHold } from '../worktree/keep-tree-hold.ts'
import { inspectTreeOwnership, worktreeDirty } from '../worktree/worktree-attribution.ts'
import { branchTip, removeFor } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { releaseAbsentCloseOutResidue } from './absent-close-out-residue.ts'
import {
  absentTreeCloseOut,
  failedResourceRemovalResult,
  pointerMustClear,
  type ResourceTeardownResult,
  successfulReleaseResult,
} from './absent-tree-close-out.ts'
import { adoptedTreeCloseOutDecision } from './close-out-adoption.ts'
import { closeTerminalChainQuestions } from './close-out-questions.ts'
import { landingTreeReleaseHold, protectRetainedBranch } from './close-out-release-holds.ts'
import {
  type ConversationKeepTreeHold,
  cleanLandingTreeCloseOutResult,
} from './close-out-report.ts'
import {
  aliveConversationTurns,
  liveCloseOutResult,
  missingTreeConversationResult,
} from './conversation-liveness.ts'
import {
  archiveReaderScratchForRelease,
  prepareReaderScratchCloseOut,
  readerScratchReleaseDetail,
} from './reader-scratch-close-out.ts'
import {
  retainedBranchForCloseOut,
  retainedBranchPruneCommand,
  retainedBranchReason,
} from './retained-branch.ts'

export type CloseOutResult = {
  runId: number
  worktree: string | null
  outcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
  reportOutcome?: 'kept'
  detail: string
}

type CloseOutAttemptResult = CloseOutResult & ResourceTeardownResult

const TERMINAL = new Set(['ok', 'failed', 'stale', 'stopped'])

function conversationKeepTreeHold(rootId: number, now: string): ConversationKeepTreeHold {
  const rows = db()
    .query(
      `SELECT job,keep_tree,keep_tree_until,keep_tree_reason,started_at,worktree,branch FROM run
       WHERE id=? OR parent_run_id=? ORDER BY id`,
    )
    .all(rootId, rootId) as {
    job: string
    keep_tree: number
    keep_tree_until: string | null
    keep_tree_reason: string | null
    started_at: string
    worktree: string | null
    branch: string | null
  }[]
  const treeExists = rows.some((row) => row.worktree !== null && existsSync(row.worktree))
  const expired: { held: false; expiredAt: string }[] = []
  for (const row of rows) {
    const decision = keepTreeHold({
      keepTree: row.keep_tree,
      keepTreeUntil: row.keep_tree_until,
      startedAt: row.started_at,
      now,
    })
    if (decision.held) {
      return landingTreeHoldDecision(
        { job: row.job, treeExists, branch: row.branch, runId: rootId },
        !row.worktree || !existsSync(row.worktree) || !worktreeDirty(row.worktree).dirty,
        hookTreeHoldDecision(
          { job: row.job, treeExists },
          {
            ...decision,
            reason: row.keep_tree_reason ?? 'explicit --keep-tree',
          },
        ),
      )
    }
    if ('expiredAt' in decision) expired.push(decision)
  }
  const latest = expired.sort((a, b) => Date.parse(b.expiredAt) - Date.parse(a.expiredAt))[0]
  const hook = rows.some((row) => row.job === HOOK_TREE_JOB) ? HOOK_TREE_JOB : ''
  const landingRows = rows.filter((row) => row.job === LANDING_TREE_JOB)
  return landingTreeHoldDecision(
    {
      job: landingRows[0]?.job ?? '',
      treeExists,
      branch: landingRows[0]?.branch ?? null,
      runId: rootId,
    },
    landingRows
      .filter((row) => row.worktree && existsSync(row.worktree))
      .every((row) => !worktreeDirty(row.worktree!).dirty),
    hookTreeHoldDecision({ job: hook, treeExists }, latest ?? { held: false as const }),
  )
}

function closeOutKeepTreeDecision(
  rootId: number,
  intent: 'terminal' | 'explicit' | 'sweep' | 'tree-remove',
): ConversationKeepTreeHold {
  if (intent === 'tree-remove') return { held: false }
  if (intent === 'sweep') {
    const landing = db()
      .query('SELECT 1 present FROM run WHERE (id=? OR parent_run_id=?) AND job=? LIMIT 1')
      .get(rootId, rootId, LANDING_TREE_JOB)
    if (landing) return { held: false }
  }
  return conversationKeepTreeHold(rootId, nowIso())
}

/** Drop the conversation root's keep-tree hold so terminal close-out can reclaim the tree. */
export function clearConversationKeepTreeHold(runId: number): void {
  const root = db()
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  if (!root) throw new Error(`no run ${runId}`)
  writeTransaction(() => {
    db()
      .query('UPDATE run SET keep_tree=0, keep_tree_until=NULL, keep_tree_reason=NULL WHERE id=?')
      .run(root.root_id)
  })
}

/** Release a run and every failover attempt it succeeded, oldest attempt first. */
export function releaseRunFailoverAttempts(runId: number): CloseOutResult[] {
  const attempts: number[] = []
  const seen = new Set<number>()
  let attemptId: number | null = runId
  while (attemptId !== null) {
    if (seen.has(attemptId)) throw new Error(`run ${runId} has a retry_of cycle at ${attemptId}`)
    seen.add(attemptId)
    attempts.push(attemptId)
    const row = db().query('SELECT retry_of FROM run WHERE id=?').get(attemptId) as {
      retry_of: number | null
    } | null
    if (!row) throw new Error(`no run ${attemptId}`)
    attemptId = row.retry_of
  }
  return attempts.reverse().map((id) => {
    clearConversationKeepTreeHold(id)
    return closeOutRun(id, { intent: 'terminal' })
  })
}

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
  options: {
    dryRun?: boolean
    worktreeState?: ResourceClaimState | 'no-tree'
  } = {},
): SandboxReleaseResult {
  const path = join(RUNS_DIR, `sandbox-${rootId}`)
  const turns = db()
    .query('SELECT status FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
    .all(rootId, rootId) as { status: string }[]
  const keepTree = conversationKeepTreeHold(rootId, nowIso())
  const decision = sandboxDirectoryRelease({
    terminal: turns.length > 0 && turns.every((turn) => TERMINAL.has(turn.status)),
    liveTurn: aliveConversationTurns(rootId).length > 0,
    liveProcess: conversationProcessState(rootId),
    worktreeState: options.worktreeState ?? recordedWorktreeState(rootId),
    keepTree: keepTree.held,
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
    return {
      rootId,
      path,
      outcome: 'absent',
      detail: 'sandbox directory was already absent',
    }
  }
  if (decision.startsWith('keep:')) {
    return {
      rootId,
      path,
      outcome: 'kept',
      detail: decision.slice('keep:'.length),
    }
  }
  if (options.dryRun) {
    return {
      rootId,
      path,
      outcome: 'released',
      detail: 'would release sandbox directory',
    }
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
  return {
    rootId,
    path,
    outcome: 'released',
    detail: `removed sandbox directory ${path}`,
  }
}

function terminalHoldResult(
  runId: number,
  treePath: string,
  status: string,
  hold: ConversationKeepTreeHold,
): CloseOutResult | null {
  if (!TERMINAL.has(status)) {
    return {
      runId,
      worktree: treePath,
      outcome: 'live',
      detail: `conversation is ${status}`,
    }
  }
  if (hold.held) {
    return {
      runId,
      worktree: treePath,
      outcome: 'held',
      detail:
        hold.until === null
          ? hold.reason
          : `held by ${hold.reason} until ${hold.until}; clear with orch discard ${runId}`,
    }
  }
  if ('kept' in hold && hold.kept)
    return cleanLandingTreeCloseOutResult(runId, treePath, hold.reason)
  return null
}

function ownershipCloseOutResult(input: {
  runId: number
  treePath: string
  decision: ReturnType<typeof adoptedTreeCloseOutDecision>
  dryRun?: boolean
}): CloseOutResult | null {
  if (input.decision === 'ordinary') return null
  if (input.decision === 'held') {
    return {
      runId: input.runId,
      worktree: input.treePath,
      outcome: 'held',
      detail: `ownership of ${input.treePath} could not be established; pointer and tree retained`,
    }
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

function otherConversationKeepTreeHeld(rootId: number, treePath: string): boolean {
  return otherConversationWorktreeSharers(db(), {
    id: rootId,
    worktree: treePath,
  }).some((holder) => conversationKeepTreeHold(holder.id, nowIso()).held)
}

function lockedLiveOrForgottenHold(
  runId: number,
  treePath: string,
  live: { id: number; status: string }[],
  dryRun?: boolean,
): CloseOutResult | null {
  const liveResult = liveCloseOutResult(runId, treePath, live)
  if (liveResult) return liveResult
  if (!otherConversationKeepTreeHeld(runId, treePath)) return null
  return ownershipCloseOutResult({
    runId,
    treePath,
    decision: 'forgotten',
    dryRun,
  })
}

function turnHeadForCloseOut(
  row: { branch: string | null; minted_branch: string | null },
  treePath: string,
): { branch: string; tip: string } | null {
  const branch = row.branch ?? row.minted_branch
  if (!branch || !existsSync(treePath)) return null
  const tip = gitContext(treePath, 'rev-parse', '--verify', 'HEAD^{commit}')
  return tip ? { branch, tip } : null
}

function presentTreeOwnershipResult(input: {
  treeAbsent: boolean
  treePath: string
  repoRoot: string
  conversationIds: number[]
  repo: string | null
  runId: number
  dryRun?: boolean
}): CloseOutResult | null {
  if (input.treeAbsent) return null
  const branchTemplate = (input.repo ? projectByName(input.repo) : projectAt(input.treePath))
    ?.settings.worktree?.branch
  const ownership = inspectTreeOwnership(
    input.treePath,
    input.repoRoot,
    input.conversationIds,
    branchTemplate,
  )
  return ownershipCloseOutResult({
    runId: input.runId,
    treePath: input.treePath,
    decision: adoptedTreeCloseOutDecision(ownership),
    dryRun: input.dryRun,
  })
}

/** One cleanup path for terminalisation, explicit close-out, and sweep. */
function attemptCloseOutRun(
  runId: number,
  options: {
    intent: 'terminal' | 'explicit' | 'sweep' | 'tree-remove'
    dryRun?: boolean
    lockTimeoutMs?: number
    extraPids?: number[]
    pgid?: number | null
    keepTreeDecision: ConversationKeepTreeHold
  },
): CloseOutAttemptResult {
  const row = db()
    .query(
      `SELECT id, COALESCE(parent_run_id,id) root_id, project_id, job, repo, cwd, worktree, branch,
            base_commit, worktree_source, minted_branch, status, agent_pid,session_id,launch_key
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
    status: string
    agent_pid: number | null
    session_id: string | null
    launch_key: string | null
  } | null
  if (!row) throw new Error(`no run ${runId}`)
  const root = db()
    .query(
      `SELECT project_id,job,repo,cwd,worktree,branch,base_commit,worktree_source,minted_branch,status,
              session_id,launch_key
       FROM run WHERE id=?`,
    )
    .get(row.root_id) as typeof row
  const resolvedTreePath = row.worktree ?? root?.worktree ?? null
  const missingTreeResult = missingTreeConversationResult(row.root_id, resolvedTreePath)
  if (missingTreeResult) return missingTreeResult
  const treePath = resolvedTreePath as string
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
    session_id: root?.session_id ?? row.session_id,
    launch_key: root?.launch_key ?? row.launch_key,
  }
  const landingReleaseInput = {
    runId: row.root_id,
    job: effective.job,
    repo: effective.repo,
    worktree: treePath,
    branch: effective.branch,
    sessionId: effective.session_id,
    launchKey: effective.launch_key,
    status: effective.status,
    explicitTreeRemovalRequested: options.intent === 'tree-remove',
  }
  const preRemovalHold =
    terminalHoldResult(row.root_id, treePath, effective.status, options.keepTreeDecision) ??
    (!existsSync(treePath) ? landingTreeReleaseHold(landingReleaseInput) : null)
  if (preRemovalHold) return preRemovalHold
  const retainedBranch = retainedBranchForCloseOut(effective.minted_branch)
  const turnHead = turnHeadForCloseOut(row, treePath)
  const recordRetainedBranch = (tip: string | null, retainedRef?: string | null) => {
    if (!retainedBranch || !tip) return
    writeTransaction(() => {
      db()
        .query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
        .run(retainedBranch, tip, row.root_id)
      if (row.id !== row.root_id && turnHead) {
        db()
          .query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
          .run(turnHead.branch, turnHead.tip, row.id)
        settleClaims(db(), {
          rootRunId: row.root_id,
          kind: 'branch',
          state: 'retained',
          settledAt: nowIso(),
          detail: `branch retained at ${turnHead.tip}`,
          allocationKey: `refs/heads/${turnHead.branch}`,
        })
      }
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
  const absentTree = absentTreeCloseOut({
    runId: row.root_id,
    treePath,
    repo: effective.repo,
    cwd: effective.cwd,
    retainedBranch,
    dryRun: options.dryRun,
    recordRetainedBranch,
  })
  if (absentTree.result) return absentTree.result
  const { absent: treeAbsent, repoRoot } = absentTree
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
  const ownershipResult = presentTreeOwnershipResult({
    treeAbsent,
    treePath,
    repoRoot,
    conversationIds,
    repo: effective.repo,
    runId: row.root_id,
    dryRun: options.dryRun,
  })
  if (ownershipResult) return ownershipResult

  const liveRows = () => {
    const sharers = liveWorktreeSharers(db(), {
      id: row.root_id,
      worktree: treePath,
    })
    const conversation = aliveConversationTurns(row.root_id)
    return [...conversation, ...sharers]
  }
  const live = liveRows()
  const liveResult = liveCloseOutResult(row.root_id, treePath, live)
  if (liveResult) return liveResult
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
        .all(...spellings) as {
        agent_pid: number | null
        agent_pgid: number | null
      }[])
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
            const lockedHold = lockedLiveOrForgottenHold(
              row.root_id,
              treePath,
              liveRows(),
              options.dryRun,
            )
            if (lockedHold) return lockedHold
            const scratch = prepareReaderScratchCloseOut({
              runId: row.root_id,
              job: effective.job,
              terminal: TERMINAL.has(effective.status),
              treeAbsent,
              treePath,
              repoRoot,
              baseCommit: effective.base_commit ?? '',
              dryRun: Boolean(options.dryRun),
            })
            if (!scratch.proceed) return scratch.result
            // The coordinator proves its own identity before descendants are signaled.
            const liveCoordinator = aliveConversationTurns(row.root_id).find(
              (turn) => turn.pid !== process.pid,
            )
            if (liveCoordinator)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'live' as const,
                detail: `coordinator lease for run ${liveCoordinator.id} is still held`,
              }
            terminateRunProcesses(row.id, [process.pid])
            const landingHold = landingTreeReleaseHold(landingReleaseInput)
            if (landingHold) return landingHold
            const archive = archiveReaderScratchForRelease({
              runId: extractionRunId(row),
              treePath,
              terminal: TERMINAL.has(effective.status),
              planned: scratch.archive,
            })
            if (!archive.ok)
              return {
                runId: row.root_id,
                worktree: treePath,
                outcome: 'held' as const,
                detail: `${archive.detail}; clone and claim retained`,
              }
            const archivedScratchPath = archive.path
            const branchSnapshot = retainedBranch ? branchTip(repoRoot, retainedBranch) : null
            const retainedRef = branchSnapshot ? `refs/orch/retained/${row.root_id}` : null
            const pinFailure = protectRetainedBranch({
              repoRoot,
              retainedRef,
              branchSnapshot,
              retainedBranch,
              runId: row.root_id,
              treePath,
            })
            if (pinFailure) return pinFailure
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
              extractionRunId(row),
              false,
              treeAbsent || archivedScratchPath !== null,
              archivedScratchPath !== null,
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
              return failedResourceRemovalResult({
                runId: row.root_id,
                treePath,
                treeAbsent,
                teardown: result,
                detail: result.detail,
              })
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
            const released = successfulReleaseResult(row.root_id, treePath, treeAbsent, result)
            released.detail = readerScratchReleaseDetail(released.detail, archivedScratchPath)
            return released
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

/** Extraction evidence belongs to the turn whose tree is being removed. */
export function extractionRunId(row: { id: number }): number {
  return row.id
}

/** Every recorded spelling of each tree this conversation points at, keyed by each spelling. */
function conversationWorktreeSpellings(rootId: number): Map<string, string[]> {
  const rows = db()
    .query(
      `SELECT DISTINCT worktree FROM run
        WHERE (id=? OR parent_run_id=?) AND worktree IS NOT NULL`,
    )
    .all(rootId, rootId) as { worktree: string }[]
  const byPath = new Map<string, string[]>()
  for (const { worktree } of rows) {
    const spellings = [...new Set([worktree, ...worktreePathSpellings(db(), worktree)])]
    for (const spelling of spellings) byPath.set(spelling, spellings)
  }
  return byPath
}

function settlementLivenessResult(result: CloseOutAttemptResult): CloseOutAttemptResult {
  if (!['released', 'absent', 'forgotten'].includes(result.outcome)) return result
  return (
    liveCloseOutResult(result.runId, result.worktree, aliveConversationTurns(result.runId)) ??
    result
  )
}

function appendRetainedBranchDetail(result: CloseOutAttemptResult): CloseOutAttemptResult {
  if (!['released', 'absent', 'forgotten'].includes(result.outcome)) return result
  const retained = db()
    .query('SELECT branch_kept,repo,launch_key FROM run WHERE id=?')
    .get(result.runId) as {
    branch_kept: string | null
    repo: string | null
    launch_key: string | null
  }
  if (!retained.branch_kept) return result
  const reason = retainedBranchReason(retained.branch_kept)
  if (result.detail.includes(reason)) return result
  const prune = retainedBranchPruneCommand(retained.repo, retained.launch_key)
  result.detail += `; ${reason}${prune ? `; prune after landing: ${prune}` : ''}`
  return result
}

/** Run one close-out attempt and retain its outcome for observation and retry. */
export function closeOutRun(
  runId: number,
  options: {
    intent: 'terminal' | 'explicit' | 'sweep' | 'tree-remove'
    dryRun?: boolean
    lockTimeoutMs?: number
    extraPids?: number[]
    pgid?: number | null
  },
): CloseOutResult {
  const root = db()
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  if (!root) throw new Error(`no run ${runId}`)
  closeTerminalChainQuestions(root.root_id, Boolean(options.dryRun))
  const keepTreeDecision = closeOutKeepTreeDecision(root.root_id, options.intent)
  // Spellings are taken while the tree still exists, because a removed
  // symlinked path no longer resolves to the identity its other rows share.
  const spellingsBefore = conversationWorktreeSpellings(root.root_id)
  let result = attemptCloseOutRun(runId, { ...options, keepTreeDecision })
  if (!keepTreeDecision.held && 'expiredAt' in keepTreeDecision) {
    result.detail = `${result.detail}; keep-tree hold expired at ${keepTreeDecision.expiredAt}`
  }
  if (!options.dryRun) {
    result = appendRetainedBranchDetail(result)
    writeTransaction(() => {
      result = settlementLivenessResult(result)
      result.detail = releaseAbsentCloseOutResidue({
        runId: result.runId,
        outcome: result.outcome,
        detail: result.detail,
        dryRun: false,
      })
      const settled = settledStateForCloseOut(result.outcome, 'worktree')
      const settledAt = nowIso()
      db()
        .query(
          `UPDATE run
            SET close_out_outcome=?, close_out_detail=?, close_out_attempted_at=?
          WHERE id=?`,
        )
        .run(result.outcome, result.detail, settledAt, result.runId)
      if (
        result.worktree &&
        pointerMustClear(result.outcome, result.worktree) &&
        !result.resourceTeardownFailed
      ) {
        const spellings = spellingsBefore.get(result.worktree) ?? [result.worktree]
        db()
          .query(
            `UPDATE run SET worktree=NULL
             WHERE (id=? OR parent_run_id=?)
               AND worktree IN (${spellings.map(() => '?').join(',')})`,
          )
          .run(result.runId, result.runId, ...spellings)
      }
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
  delete result.resourceTeardownCompleted
  delete result.resourceTeardownFailed
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
  if (!options.dryRun && ['released', 'absent', 'forgotten'].includes(result.outcome)) {
    const turns = db()
      .query('SELECT id FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
      .all(result.runId, result.runId) as { id: number }[]
    for (const turn of turns) removeFreeRunLease(turn.id)
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
