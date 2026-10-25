// concern: run-liveness
/**
 * Knows process and chain liveness, stale transition, audit, root roll-up, and the paired run-record enqueue. Must not know routing, transports, reviews, or CLI adapters.
 */

import type { Database } from 'bun:sqlite'
import { pidAlive } from '../../../shared/process-identity.ts'
import { linkedWorktreeReadOnly, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  liveWorktreeSharers,
  teardownTerminalRunResources,
} from '../resources/resource-ownership.ts'
import {
  closeRunChainQuestions,
  QUESTION_CLOSE_CHAIN_STALE,
  retireRunChainQuestionDeliveries,
} from './question-close.ts'
import { questionOpenSql } from './question-open.ts'
import { runAlive } from './run-alive.ts'
import { auditRunMutation, runMutationAuthority } from './run-authority.ts'
import { abandonedBootstrap, coordinatorSetupDeath, PENDING_BOOTSTRAP_MS } from './run-bootstrap.ts'
import { chainTerminationAtForRoot } from './run-chain.ts'
import { coordinatorSetupError, recordedCoordinatorCause } from './run-coordinator-log.ts'
import { runLeaseState } from './run-lease.ts'
import { STALE_AFTER_MS } from './run-liveness-policy.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import {
  type RecordedRunSharedGitConfigInput,
  sharedGitConfigCheckSkipReason,
} from './shared-git-config-check.ts'

/**
 * The outer ceiling for a run and for callers waiting on one. Liveness itself
 * comes from the coordinator's kernel lease; elapsed time is not evidence that
 * a quiet worker, including one blocked on a ruling, has died.
 */
/** The common bound for callers following a detached run to its terminal state. */
export const RUN_FOLLOW_TIMEOUT_MS = STALE_AFTER_MS + 60_000

/**
 * When the terminal outcome of a conversation chain became observable.
 *
 * A root may inherit the last child's status, but it does not inherit that
 * child's timing. Read the terminal member itself: root arithmetic can put a
 * failure hours before or after it actually happened. Until the schema holds
 * an explicit terminal timestamp, a member without latency has no supportable
 * terminal time and returns null.
 */
export function chainTerminationAt(database: Database, memberId: string): string | null {
  const member = database
    .query('SELECT record_id, parent_run_record_id FROM run WHERE record_id=?')
    .get(memberId) as {
    record_id: string
    parent_run_record_id: string | null
  } | null
  if (!member) return null
  const rootId = member.parent_run_record_id ?? member.record_id
  return chainTerminationAtForRoot(database, rootId)
}

/**
 * A root inherits the terminal status of the last turn of its chain.
 *
 * Counterpart of `resolveSupersededTurn` in failover.ts, which is child-only and
 * cannot touch a root: the root is routing evidence, and giving it a terminal
 * status inserts a judgment. That is the point here, not an accident. A chain
 * that ended stale is a real outcome of a real agent; hiding it would make the
 * router's picture of that agent better than the truth.
 *
 * Chain structure only — no pid, no agent_pid, no process.kill. A worker exits
 * when it stops to ask, so those are dead for every asking run including live
 * ones. A root with an unanswered question is waiting, not stranded, and is
 * left alone. A last turn that is still `asking` is recoverable (`orch
 * continue`), not ended, so it is left alone too.
 *
 * The root may be `asking` after the first turn, or `ok`/`failed` while a
 * later resumed turn finishes. The unanswered-question and last-terminal-turn
 * guards protect stranded roots without blocking ordinary resumed roll-up. `stopped`
 * and `stale` roots remain locked because those lifecycle decisions must not
 * be undone by a worker finishing concurrently, and a `running` root is a live
 * first turn that a stale child row must never overwrite (lens run 2277).
 *
 * The terminal turn's error and failure_kind are part of that state and travel
 * with its status. The deliberate kind exceptions are lifecycle outcomes that
 * would erase the root's judgment from routing: stale and abandoned children
 * always retain the root's kind, and the reaper identifies coordinator setup
 * deaths that do too.
 */
function resolveRootFromLastTurnPreserving(
  database: Database,
  rootId: string,
  preserveFailureKindForTurnId: string | null,
): number {
  return database
    .query(
      `UPDATE run AS root
        SET status = (
          SELECT last.status FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            error = (
          SELECT last.error FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            failure_kind = (
          SELECT CASE
                   WHEN last.record_id = ? OR last.status = 'stale' OR last.failure_kind = 'abandoned'
                     THEN root.failure_kind
                   ELSE last.failure_kind
                 END
            FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            pre_confinement = (
          SELECT last.pre_confinement FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            confinement = (
          SELECT last.confinement FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            tests_ran = (
          SELECT last.tests_ran FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            tests_passed = (
          SELECT last.tests_passed FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ),
            tests_claim_disagrees = (
          SELECT last.tests_claim_disagrees FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        )
      WHERE root.record_id = ?
        AND root.parent_run_record_id IS NULL
        AND root.status IN ('asking', 'ok', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM question q JOIN run owner ON owner.record_id = q.run_record_id
           WHERE (owner.record_id = root.record_id OR owner.parent_run_record_id = root.record_id)
             AND ${questionOpenSql('q')}
        )
        AND (
          SELECT last.status FROM run last
           WHERE last.record_id = root.record_id OR last.parent_run_record_id = root.record_id
           ORDER BY last.turn DESC, last.number DESC
           LIMIT 1
        ) IN ('ok', 'failed', 'stale')`,
    )
    .run(preserveFailureKindForTurnId, rootId).changes
}

export function rollUpRootAndEnqueue(
  database: Database,
  rootId: string,
  preserveFailureKindForTurnId: string | null,
  machine: string,
  finishedAt: string,
): number {
  const changes = resolveRootFromLastTurnPreserving(database, rootId, preserveFailureKindForTurnId)
  enqueueRunRecord(database, rootId, machine, finishedAt)
  return changes
}

/** Append a terminal check result and serialize that same state for the hosted record. */
export function recordRunSharedGitConfigHeader(
  database: Database,
  runId: string,
  header: string,
  machine: string,
  finishedAt: string,
): void {
  writeTransaction(() => {
    database.query("UPDATE run SET error=error || '\n' || ? WHERE record_id=?").run(header, runId)
    enqueueRunRecord(database, runId, machine, finishedAt)
  }, database)
}

function rollUpReapedRoots(
  database: Database,
  ended: string[],
  setupDeathIds: Set<string>,
  machine: string,
  finishedAt: string,
): void {
  const roots = database
    .query(
      `SELECT DISTINCT COALESCE(ended.parent_run_record_id, ended.record_id) AS root_record_id,
        (SELECT last.record_id FROM run last
          WHERE last.record_id = COALESCE(ended.parent_run_record_id, ended.record_id)
             OR last.parent_run_record_id = COALESCE(ended.parent_run_record_id, ended.record_id)
          ORDER BY last.turn DESC, last.number DESC LIMIT 1) AS last_record_id
      FROM run ended WHERE ended.record_id IN (${ended.map(() => '?').join(',')})`,
    )
    .all(...ended) as { root_record_id: string; last_record_id: string }[]
  for (const { root_record_id, last_record_id } of roots) {
    writeTransaction(() => {
      rollUpRootAndEnqueue(
        database,
        root_record_id,
        preservedFailureKindTurnId(setupDeathIds, last_record_id),
        machine,
        finishedAt,
      )
      retireRunChainQuestionDeliveries(database, root_record_id, QUESTION_CLOSE_CHAIN_STALE)
    }, database)
  }
}

/**
 * A run only writes its terminal state on the normal path, so a process that is
 * killed — or whose session ends — leaves its row claiming to be live for ever.
 * Those rows inflate "in flight" and hide in `--unscored`, so they are swept to
 * a distinct status rather than silently counted as either running or failed.
 *
 * Current runs are alive exactly while their coordinator lease is held. Rows
 * predating the lease fall back to their recorded PID; elapsed time is never a
 * liveness signal.
 *
 * Returns how many were swept. Called opportunistically on open: cheap, and it
 * means no separate cron has to remember.
 */
export type ObservedDeadRun = { record_id: string; reason: string }

type RunningRow = {
  number: number
  record_id: string
  pid: number | null
  agent_pid: number | null
  agent: string
  started_at: string
  job: string
  worktree: string | null
}

function deadRunReason(row: RunningRow): string {
  if (runLeaseState(row.record_id) === 'free') return `run lease ${row.number} is free`
  if (row.pid) return `pid ${row.pid} is not alive`
  return 'legacy run has no live pid'
}

type RunningDisposition =
  | 'alive'
  | 'dead'
  | 'abandoned-bootstrap'
  | 'setup-death'
  | 'recorded-cause'

function preservedFailureKindTurnId(setupDeathIds: Set<string>, lastTurnId: string): string | null {
  return setupDeathIds.has(lastTurnId) ? lastTurnId : null
}

function runningDisposition(row: RunningRow, now: number): RunningDisposition {
  const leaseState = runLeaseState(row.record_id)
  const coordinatorPidAlive = Boolean(row.pid && pidAlive(row.pid))
  let disposition: RunningDisposition
  if (row.agent === '(pending)') {
    disposition = abandonedBootstrap({
      agent: row.agent,
      pid: row.pid,
      pidAlive: coordinatorPidAlive,
      leaseState,
      startedAt: row.started_at,
      now,
    })
      ? 'abandoned-bootstrap'
      : 'alive'
  } else if (
    coordinatorSetupDeath({
      agent: row.agent,
      agentPidPresent: row.agent_pid !== null,
      leaseState,
      pidAlive: coordinatorPidAlive,
    })
  ) {
    disposition = 'setup-death'
  } else {
    disposition = runAlive({
      status: 'running',
      lease: leaseState,
      pidAlive: coordinatorPidAlive,
    })
      ? 'alive'
      : 'dead'
  }
  if (disposition !== 'alive' && recordedCoordinatorCause(row.record_id)) return 'recorded-cause'
  return disposition
}

function coordinatorSetupDeathError(rows: RunningRow[], id: string): string {
  const recordId = rows.find((candidate) => candidate.record_id === id)!.record_id
  return coordinatorSetupError(recordId)
}

function setupDeathObservation(rows: RunningRow[], recordId: string): ObservedDeadRun {
  return {
    record_id: recordId,
    reason: coordinatorSetupDeathError(rows, recordId),
  }
}

type ReapedRunGroups = {
  dead: string[]
  abandonedBootstraps: string[]
  setupDeaths: string[]
  recordedCauseDeaths: string[]
}

function groupReapedRuns(rows: RunningRow[], now: number): ReapedRunGroups {
  const groups: ReapedRunGroups = {
    dead: [],
    abandonedBootstraps: [],
    setupDeaths: [],
    recordedCauseDeaths: [],
  }
  const target: Record<Exclude<RunningDisposition, 'alive'>, keyof ReapedRunGroups> = {
    dead: 'dead',
    'abandoned-bootstrap': 'abandonedBootstraps',
    'setup-death': 'setupDeaths',
    'recorded-cause': 'recordedCauseDeaths',
  }
  for (const row of rows) {
    const disposition = runningDisposition(row, now)
    if (disposition !== 'alive') groups[target[disposition]].push(row.record_id)
  }
  return groups
}

function terminalizeHarnessFailures(
  database: Database,
  ids: string[],
  errorFor: (id: string) => string,
  localMachineId: string,
  finishedAt: string,
): void {
  if (!ids.length) return
  const update = database.query(
    `UPDATE run SET status='failed', failure_kind='harness', error=?, host_wait_since=NULL
      WHERE record_id=? AND status='running'`,
  )
  for (const id of ids) {
    const error = errorFor(id)
    writeTransaction(() => {
      if (update.run(error, id).changes !== 1) return
      const authority = runMutationAuthority(database, id)
      auditRunMutation(authority, 'reap', error, database)
      closeRunChainQuestions(database, authority.rootId, QUESTION_CLOSE_CHAIN_STALE)
      enqueueRunRecord(database, id, localMachineId, finishedAt)
    }, database)
  }
}

function finalizeReapedRuns(
  database: Database,
  ended: string[],
  setupDeaths: string[],
  localMachineId: string,
  finishedAt: string,
): void {
  if (!ended.length) return
  rollUpReapedRoots(database, ended, new Set(setupDeaths), localMachineId, finishedAt)
  for (const id of ended) teardownTerminalRunResources(database, id)
}

export function reapStale(
  d: Database,
  checkSharedGitConfig: (input: RecordedRunSharedGitConfigInput) => string | null,
): number | ObservedDeadRun[] {
  const now = Date.now()
  const rows = d
    .query(
      `SELECT number, record_id, pid, agent_pid, agent, started_at, job, worktree FROM run WHERE status='running'`,
    )
    .all() as RunningRow[]

  const { dead, abandonedBootstraps, setupDeaths, recordedCauseDeaths } = groupReapedRuns(rows, now)
  if (linkedWorktreeReadOnly) {
    return [
      ...dead.map((id) => {
        const row = rows.find((candidate) => candidate.record_id === id)!
        return {
          record_id: id,
          reason: deadRunReason(row),
        }
      }),
      ...abandonedBootstraps.map((id) => ({
        record_id: id,
        reason: `pending coordinator was abandoned after ${PENDING_BOOTSTRAP_MS}ms`,
      })),
      ...setupDeaths.map((id) => setupDeathObservation(rows, id)),
      ...recordedCauseDeaths.map((id) => ({
        record_id: id,
        reason: recordedCoordinatorCause(id)!,
      })),
    ]
  }
  const ended = [...dead, ...abandonedBootstraps, ...setupDeaths, ...recordedCauseDeaths]
  const localMachineId = ended.length ? machineId() : ''
  const finishedAt = new Date(now).toISOString()
  if (abandonedBootstraps.length) {
    const update = d.query(
      `UPDATE run SET status='failed', failure_kind='harness', host_wait_since=NULL,
              error=? WHERE record_id=? AND status='running'`,
    )
    for (const id of abandonedBootstraps) {
      const error = coordinatorSetupDeathError(rows, id)
      writeTransaction(() => {
        if (update.run(error, id).changes !== 1) return
        const authority = runMutationAuthority(d, id)
        auditRunMutation(authority, 'reap', error, d)
        closeRunChainQuestions(d, authority.rootId, QUESTION_CLOSE_CHAIN_STALE)
        enqueueRunRecord(d, id, localMachineId, finishedAt)
      }, d)
    }
  }
  terminalizeHarnessFailures(
    d,
    setupDeaths,
    (id) => coordinatorSetupDeathError(rows, id),
    localMachineId,
    finishedAt,
  )
  terminalizeHarnessFailures(
    d,
    recordedCauseDeaths,
    (id) => recordedCoordinatorCause(id)!,
    localMachineId,
    finishedAt,
  )
  if (dead.length) {
    // Stamped `interrupted`, which puts these under the same NOT_EVIDENCE rule as
    // an exit-143 kill instead of leaving routing a second concept to know about.
    //
    // A reaped row can ONLY be an external kill: run() holds its lease until
    // after its terminal write. Reaching here means that write could not run,
    // such as after SIGKILL or the parent's process group going down.
    //
    // Run 521 is the worked example. A delegation in this very session was killed
    // by the calling harness's command timeout and landed here - a fact about the
    // caller, charged until now to qwen36-goose.
    for (const id of dead) {
      const row = rows.find((candidate) => candidate.record_id === id)!
      reapDeadRun(d, row, checkSharedGitConfig, localMachineId, finishedAt)
    }
  }
  finalizeReapedRuns(d, ended, [...setupDeaths, ...recordedCauseDeaths], localMachineId, finishedAt)
  return dead.length + abandonedBootstraps.length + setupDeaths.length + recordedCauseDeaths.length
}

function reapDeadRun(
  d: Database,
  row: RunningRow,
  checkSharedGitConfig: (input: RecordedRunSharedGitConfigInput) => string | null,
  localMachineId: string,
  finishedAt: string,
): void {
  const id = row.record_id
  const vendorAlive = row.agent_pid && pidAlive(row.agent_pid)
  const surviving = vendorAlive ? `; vendor pid ${row.agent_pid} still alive` : ''
  const baseError = `abandoned: process gone, no terminal state recorded${surviving}`
  const reason = deadRunReason(row) + surviving
  const claimed = writeTransaction(() => {
    const update = d.query(
      `UPDATE run SET status='stale', failure_kind='interrupted', error=?, host_wait_since=NULL
        WHERE record_id=? AND status='running'`,
    )
    if (update.run(baseError, id).changes !== 1) return false
    const authority = runMutationAuthority(d, id)
    auditRunMutation(authority, 'reap', reason, d)
    closeRunChainQuestions(d, authority.rootId, QUESTION_CLOSE_CHAIN_STALE)
    enqueueRunRecord(d, id, localMachineId, finishedAt)
    return true
  }, d)
  if (!claimed) return
  const sharerCount =
    !vendorAlive && row.worktree
      ? liveWorktreeSharers(d, { record_id: id, worktree: row.worktree }).length
      : 0
  const skipReason = sharedGitConfigCheckSkipReason({
    vendorPid: row.agent_pid,
    vendorAlive: Boolean(vendorAlive),
    worktree: row.worktree,
    sharerCount,
  })
  if (skipReason) {
    recordRunSharedGitConfigHeader(d, id, skipReason, localMachineId, finishedAt)
    return
  }
  // The check spawns git, so it runs after the claim commits rather than holding the write lock.
  const header = checkSharedGitConfig({ runId: id, job: row.job, worktree: row.worktree })
  if (!header) return
  recordRunSharedGitConfigHeader(d, id, header, localMachineId, finishedAt)
}
