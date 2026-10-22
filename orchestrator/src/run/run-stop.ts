/** Run stop knows run terminal writes, worktree ownership, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
import { JOBS } from '../jobs/jobs.ts'
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
import { rollUpRootAndEnqueue } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import type {
  RunProcessTerminationPlan,
  TerminateRunProcessesResult,
  VerifiedRunProcessTermination,
} from './run-process.ts'
import { stoppedWorktreeDisposition, stoppedWorktreeLine } from './stopped-worktree-decision.ts'

export function stoppedRunLine(id: string): string {
  return `stopped run ${id}`
}

export function stopTerminationRefusal(
  row: { record_id: string },
  termination: TerminateRunProcessesResult,
): string | null {
  if (termination.outcome === 'identity-mismatch') {
    const pid = termination.pid
    return (
      `run ${row.record_id} pid ${pid} identity could not be confirmed; the run remains running; ` +
      `after checking ps -p ${pid} -o lstart=,command=, run kill -TERM ${pid} only if the start time matches the recorded agent_start_time`
    )
  }
  if (termination.outcome === 'still-alive') {
    const pid = termination.pid
    return (
      `run ${row.record_id} is recorded stopped; process ${pid} is still alive; ` +
      `after checking ps -p ${pid} -o lstart=,command=, run kill -KILL ${pid}`
    )
  }
  return null
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

function stopJobIsReadOnly(jobName: string | null | undefined): boolean {
  const needs = jobName ? JOBS[jobName]?.needs : undefined
  return Boolean(needs?.readsRepo) && !needs?.writesRepo
}

function logStoppedRun(
  options: RunStopOptions,
  row: StopRow,
  cleanupRow: ReturnType<typeof stopCleanupRow>,
  dockerTeardown: TerminalDockerTeardown,
): void {
  options.presentation.log(stoppedRunLine(row.record_id))
  const disposition = stoppedWorktreeDisposition({
    readOnlyJob: stopJobIsReadOnly(cleanupRow.job),
    worktree: cleanupRow.worktree,
  })
  if (disposition !== 'none' && cleanupRow.worktree) {
    options.presentation.log(
      stoppedWorktreeLine(
        disposition,
        cleanupRow.worktree,
        cleanupRow.branch,
        branchDeletionProvenanceRefusal(cleanupRow.record_id, cleanupRow.branch) === null,
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
type RunControlHelpers = {
  lifecycleCheckpoint: (name: string) => void
}
export type RunStopHelpers = RunControlHelpers & {
  planRunProcessTermination: (runId: string, exceptPids?: number[]) => RunProcessTerminationPlan
  terminateRunProcesses: (plan: VerifiedRunProcessTermination) => TerminateRunProcessesResult
}

function enqueueAbandonedChain(rowId: string, rootId: string, at: string): void {
  const localMachineId = machineId()
  enqueueRunRecord(db(), rowId, localMachineId, at)
  rollUpRootAndEnqueue(db(), rootId, null, localMachineId, at)
}

type StopRow = {
  record_id: string
  status: string
  pid: number | null
  agent_pid: number | null
  parent_run_record_id: string | null
  turn: number
  job: string
  repo: string | null
  cwd: string | null
  worktree: string | null
  branch: string | null
  base_commit: string | null
  worktree_source: Worktree['source'] | null
}

function readStopChain(rootId: string): StopRow[] {
  return db()
    .query(
      `SELECT record_id, number, status, pid, agent_pid, parent_run_record_id, turn, job, repo, cwd, worktree, branch,
            base_commit, worktree_source
       FROM run WHERE record_id = ? OR parent_run_record_id = ? ORDER BY turn DESC, number DESC`,
    )
    .all(rootId, rootId) as StopRow[]
}

function describeStopChain(chain: StopRow[]): string {
  return [...chain]
    .reverse()
    .map((turn) => `${turn.record_id} turn ${turn.turn} ${turn.status}`)
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
    job: row.job ?? root.job ?? artifact?.job,
  }
}

function keptBranchProvenanceRefusal(row: {
  record_id: string
  branch: string | null
}): string | null {
  return branchDeletionProvenanceRefusal(row.record_id, row.branch)
}

function runningStopTurn(rootId: string, id: string): StopRow {
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
  id: string,
  auditReason: string | null,
): { row: StopRow; cleanupRow: ReturnType<typeof stopCleanupRow> } {
  const chain = readStopChain(authority.rootId)
  const row = chain.find((turn) => turn.status === 'running')
  if (!row) {
    throw new Error(
      `run ${id}'s chain has no running turn — nothing to stop: ${describeStopChain(chain)}`,
    )
  }
  const root = chain.find((turn) => turn.record_id === authority.rootId)!
  const cleanupRow = stopCleanupRow(chain, root, row)
  const next = adoptRunMutation(reauthorizeRunMutation(authority, 'stop'), 'stop')
  const changed = db()
    .query(
      "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped', host_wait_since=NULL WHERE record_id=? AND status='running'",
    )
    .run(row.record_id)
  if (changed.changes !== 1) {
    throw new Error(
      `run ${id}'s chain changed before it could be stopped: ${describeStopChain(
        readStopChain(authority.rootId),
      )}`,
    )
  }
  if (row.record_id !== next.rootId) {
    db()
      .query(
        "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped', host_wait_since=NULL WHERE record_id=?",
      )
      .run(next.rootId)
  }
  auditRunMutation(next, 'stop', auditReason)
  closeRunChainQuestions(db(), next.rootId, QUESTION_CLOSE_CHAIN_STOPPED)
  return { row, cleanupRow }
}

export async function stopRun(
  id: string,
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
  const plan = helpers.planRunProcessTermination(
    candidate.record_id,
    candidate.pid ? [candidate.pid] : [],
  )
  if (plan.outcome === 'identity-mismatch') {
    throw new Error(stopTerminationRefusal(candidate, plan)!)
  }
  const { row, cleanupRow } = writeTransaction(() =>
    commitStoppedRun(authority, id, options.auditReason),
  )
  if (plan.outcome === 'verified') {
    const termination = helpers.terminateRunProcesses(plan)
    const refusal = stopTerminationRefusal(row, termination)
    if (refusal) throw new Error(refusal)
  }
  logStoppedRun(options, row, cleanupRow, teardownTerminalRunResources(db(), row.record_id))
}

export async function abandonRun(
  id: string,
  options: RunStopOptions,
  helpers: RunControlHelpers,
): Promise<void> {
  let authority = authorizeRunMutation(id, 'abandon')
  helpers.lifecycleCheckpoint('abandon-before-immediate')
  type AbandonRow = {
    record_id: string
    status: string
    repo: string | null
    cwd: string | null
    worktree: string | null
    branch: string | null
    parent_run_record_id: string | null
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
        `SELECT record_id, number, status, repo, cwd, worktree, branch, parent_run_record_id, turn, base_commit,
              worktree_source
         FROM run WHERE record_id = ? OR parent_run_record_id = ? ORDER BY turn DESC, number DESC`,
      )
      .all(authority.rootId, authority.rootId) as AbandonRow[]
  const describe = (chain: AbandonRow[]) =>
    [...chain]
      .reverse()
      .map((turn) => `${turn.record_id} turn ${turn.turn} ${turn.status}`)
      .join('; ')

  const abandoned = writeTransaction(() => {
    const chain = readChain()
    const row = chain[0]
    if (row?.status !== 'asking') {
      const remedy =
        row?.status === 'running'
          ? `; run ${PLATFORM_SLUG} run stop ${id} to stop its running turn`
          : row
            ? `; the latest turn is already terminal (${row.status}), so no lifecycle verb applies`
            : '; no lifecycle verb applies to an empty chain'
      throw new Error(
        `run ${id}'s chain has no asking turn — nothing to abandon${remedy}: ${describe(chain)}`,
      )
    }
    const root = chain.find((turn) => turn.record_id === authority.rootId)!
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
      .query<{ record_id: string }, [string, string]>(
        `SELECT record_id FROM question WHERE ${questionOpenSql('question')} AND run_record_id IN
          (SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=?)`,
      )
      .all(authority.rootId, authority.rootId)
    const changed = db()
      .query(
        "UPDATE run SET status='stale', error=?, failure_kind='abandoned', host_wait_since=NULL WHERE record_id=? AND status='asking'",
      )
      .run(error, row.record_id)
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
          WHERE ${questionOpenSql('question')} AND run_record_id IN
            (SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=?)`,
      )
      .run(
        callerSession ?? 'anonymous (no session id)',
        at,
        ANSWERER_KIND_AGENT,
        ANSWER_CHANNEL_CLI,
        authority.rootId,
        authority.rootId,
      )
    enqueueAbandonedChain(row.record_id, authority.rootId, at)
    for (const question of openQuestions) enqueueQuestionRecord(db(), question.record_id)
    retireRunChainQuestionDeliveries(db(), authority.rootId, 'abandoned', at)
    auditRunMutation(authority, 'abandon', note ?? null)
    return { row, cleanupRow }
  })
  const { row, cleanupRow } = abandoned
  teardownTerminalRunResources(db(), row.record_id)
  options.presentation.log(`abandoned run ${row.record_id}`)

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
    const provenanceRefusal = keptBranchProvenanceRefusal(cleanupRow)
    if (provenanceRefusal) {
      options.presentation.log(provenanceRefusal)
      return
    }
    const ownersBefore = evidenceOwningBranchOwners(cleanupRow, repoRoot)
    if (ownersBefore.length) {
      options.presentation.log(
        `branch ${cleanupRow.branch} left because run ${ownersBefore[0]!.record_id} records it`,
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
        .query('UPDATE run SET branch_kept=?, branch_kept_tip=NULL WHERE record_id=?')
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
    // The snapshot is the tip discard classified when it decided to delete.
    const removed = removeBranch(repoRoot, cleanupRow.branch!, snapshot)
    const ownersAfter = evidenceOwningBranchOwners(cleanupRow, repoRoot, snapshot)
    const outcome = verifyBranchOwnershipAfterCleanup(
      cleanupRow.record_id,
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
