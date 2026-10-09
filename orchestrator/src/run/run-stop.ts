/** Run stop knows run terminal writes, worktree ownership, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */

import {
  branchDeletionProvenanceRefusal,
  type CleanupOptions,
  type CleanupRow,
  cleanupRepoRoot,
  discardWorktree,
  evidenceOwningBranchOwners,
  verifyBranchOwnershipAfterCleanup,
  withCleanupLock,
} from '../cleanup/cleanup.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  type TerminalDockerTeardown,
  teardownTerminalRunResources,
} from '../resources/resource-ownership.ts'
import { branchTip, removeBranch, unmergedBranch } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  closeRunChainQuestions,
  QUESTION_CLOSE_CHAIN_STOPPED,
  retireRunChainQuestionDeliveries,
} from './question-close.ts'
import { questionOpenSql } from './question-open.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import { ANSWER_CHANNEL_CLI, ANSWERER_KIND_AGENT } from './question-vocabulary.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  type RootAuthority,
  reauthorizeRunMutation,
} from './run-authority.ts'
import { resolveRootFromLastTurn } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'

export type TerminateRunProcessesResult =
  | { outcome: 'signaled'; signaled: number[] }
  | { outcome: 'identity-mismatch'; pid: number }
  | { outcome: 'no-pid' }
  | { outcome: 'gone' }
  | { outcome: 'still-alive'; pid: number; reason: string }

export function stoppedRunLine(id: number): string {
  return `stopped run ${id}`
}

export function stopTerminationRefusal(
  row: { id: number },
  termination: TerminateRunProcessesResult,
): string | null {
  if (termination.outcome === 'identity-mismatch') {
    const pid = termination.pid
    return (
      `run ${row.id} pid ${pid} identity could not be confirmed; the run remains running; ` +
      `after checking ps -p ${pid} -o lstart=,command=, run kill -TERM ${pid} only if the start time matches the recorded agent_start_time`
    )
  }
  if (termination.outcome === 'still-alive') {
    const pid = termination.pid
    return (
      `run ${row.id} pid ${pid} is still alive after ${termination.reason}; the run remains running; ` +
      `after checking ps -p ${pid} -o lstart=,command=, run kill -TERM ${pid}`
    )
  }
  return null
}

function stoppedWorktreeLine(
  worktree: string,
  branch: string | null,
  branchOwnedByConversation: boolean,
  dockerMessage: string,
): string {
  const keptBranch = branchOwnedByConversation ? ` and branch ${branch}` : ''
  return `kept worktree ${worktree}${keptBranch} for continuation; ${dockerMessage}`
}

function dockerStopMessage(dockerTeardown: TerminalDockerTeardown): string {
  if (!dockerTeardown.complete) {
    return dockerTeardown.removed
      ? 'reclaimed Docker containers, but reclamation was incomplete'
      : 'Docker container reclamation was incomplete'
  }
  if (dockerTeardown.outcome === 'removed') return 'reclaimed Docker containers'
  if (dockerTeardown.outcome === 'live-sibling') {
    return 'left Docker containers in place because another live run still owns the tree'
  }
  if (dockerTeardown.outcome === 'unascertainable') {
    return `left Docker containers in place because removal could not be ascertained: ${dockerTeardown.reason}`
  }
  return 'found no Docker containers to reclaim'
}

function logStoppedRun(
  options: RunStopOptions,
  row: StopRow,
  cleanupRow: ReturnType<typeof stopCleanupRow>,
  dockerTeardown: TerminalDockerTeardown,
): void {
  options.presentation.log(stoppedRunLine(row.id))
  if (cleanupRow.worktree) {
    options.presentation.log(
      stoppedWorktreeLine(
        cleanupRow.worktree,
        cleanupRow.branch,
        branchDeletionProvenanceRefusal(cleanupRow.id, cleanupRow.branch) === null,
        dockerStopMessage(dockerTeardown),
      ),
    )
    return
  }
  if (dockerTeardown.outcome === 'unascertainable') {
    options.presentation.log(
      `left Docker containers in place because removal could not be ascertained: ${dockerTeardown.reason}`,
    )
  }
}

export type RunStopOptions = CleanupOptions & { note?: string }
export type RunStopHelpers = {
  lifecycleCheckpoint: (name: string) => void
  terminateRunProcesses: (runId: number, exceptPids?: number[]) => TerminateRunProcessesResult
}

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

function readStopChain(rootId: number): StopRow[] {
  return db()
    .query(
      `SELECT id, status, pid, agent_pid, parent_run_id, turn, repo, cwd, worktree, branch,
            base_commit, worktree_source
       FROM run WHERE id = ? OR parent_run_id = ? ORDER BY turn DESC, id DESC`,
    )
    .all(rootId, rootId) as StopRow[]
}

function describeStopChain(chain: StopRow[]): string {
  return [...chain]
    .reverse()
    .map((turn) => `${turn.id} turn ${turn.turn} ${turn.status}`)
    .join('; ')
}

function stopCleanupRow(chain: StopRow[], root: StopRow, row: StopRow) {
  const artifact = chain.find((turn) => turn.worktree)
  return {
    ...root,
    worktree: row.worktree ?? artifact?.worktree ?? null,
    branch: root.branch ?? row.branch ?? artifact?.branch ?? null,
    base_commit: root.base_commit ?? row.base_commit ?? artifact?.base_commit ?? null,
    worktree_source:
      root.worktree_source ?? row.worktree_source ?? artifact?.worktree_source ?? null,
  }
}

function runningStopTurn(rootId: number, id: number): StopRow {
  const chain = readStopChain(rootId)
  const row = chain.find((turn) => turn.status === 'running')
  if (!row) {
    throw new Error(
      `run ${id}'s chain has no running turn — nothing to stop: ${describeStopChain(chain)}`,
    )
  }
  return row
}

function commitStoppedRun(
  authority: RootAuthority,
  id: number,
  auditReason: string | null,
): { row: StopRow; cleanupRow: ReturnType<typeof stopCleanupRow> } {
  const chain = readStopChain(authority.rootId)
  const row = chain.find((turn) => turn.status === 'running')
  if (!row) {
    throw new Error(
      `run ${id}'s chain has no running turn — nothing to stop: ${describeStopChain(chain)}`,
    )
  }
  const root = chain.find((turn) => turn.id === authority.rootId)!
  const cleanupRow = stopCleanupRow(chain, root, row)
  const next = adoptRunMutation(reauthorizeRunMutation(authority, 'stop'), 'stop')
  const changed = db()
    .query(
      "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped' WHERE id=? AND status='running'",
    )
    .run(row.id)
  if (changed.changes !== 1) {
    throw new Error(
      `run ${id}'s chain changed before it could be stopped: ${describeStopChain(
        readStopChain(authority.rootId),
      )}`,
    )
  }
  if (row.id !== next.rootId) {
    db()
      .query(
        "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped' WHERE id=?",
      )
      .run(next.rootId)
  }
  auditRunMutation(next, 'stop', auditReason)
  closeRunChainQuestions(db(), next.rootId, QUESTION_CLOSE_CHAIN_STOPPED)
  return { row, cleanupRow }
}

export async function stopRun(
  id: number,
  options: RunStopOptions,
  helpers: RunStopHelpers,
): Promise<void> {
  const authority = authorizeRunMutation(id, 'stop')
  helpers.lifecycleCheckpoint('stop-before-immediate')
  const candidate = runningStopTurn(authority.rootId, id)
  // The coordinator owns setup and final recording. Killing it inside the
  // creation window strands the project tool's directory before it can be
  // attributed or reclaimed. Stop the vendor, but let the coordinator see
  // the stopped row and finish recording. The tree remains the continuation
  // substrate; only its recreatable containers are reclaimed at stop.
  const termination = helpers.terminateRunProcesses(
    candidate.id,
    candidate.pid ? [candidate.pid] : [],
  )
  const refusal = stopTerminationRefusal(candidate, termination)
  if (refusal) throw new Error(refusal)
  const { row, cleanupRow } = writeTransaction(() =>
    commitStoppedRun(authority, id, options.auditReason),
  )
  logStoppedRun(options, row, cleanupRow, teardownTerminalRunResources(db(), row.id))
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
    authority = reauthorizeRunMutation(authority, 'abandon')
    authority = adoptRunMutation(authority, 'abandon')
    const openQuestions = db()
      .query<{ id: number }, [number, number]>(
        `SELECT id FROM question WHERE ${questionOpenSql('question')} AND run_id IN
          (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      )
      .all(authority.rootId, authority.rootId)
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
        `UPDATE question SET answered_by=?, answered_at=?, answer='(abandoned)', revision=revision+1,
            answerer_kind=?, answer_channel=?, delivery_pending_at=NULL,
            awaiting_operator_at=NULL
          WHERE ${questionOpenSql('question')} AND run_id IN
            (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      )
      .run(
        callerSession ?? 'anonymous (no session id)',
        at,
        ANSWERER_KIND_AGENT,
        ANSWER_CHANNEL_CLI,
        authority.rootId,
        authority.rootId,
      )
    enqueueRunRecord(db(), row.id, machineId(), at)
    for (const question of openQuestions) enqueueQuestionRecord(db(), question.id)
    resolveRootFromLastTurn(db(), authority.rootId)
    retireRunChainQuestionDeliveries(db(), authority.rootId, 'abandoned', at)
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
    const provenanceRefusal = branchDeletionProvenanceRefusal(cleanupRow.id, cleanupRow.branch)
    if (provenanceRefusal) {
      options.presentation.log(provenanceRefusal)
      return
    }
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
