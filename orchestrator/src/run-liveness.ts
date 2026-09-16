// concern: run-liveness
/**
 * Knows process and chain liveness, stale transition, audit, and root roll-up. Must not know routing, transports, reviews, or CLI adapters.
 */

import type { Database } from 'bun:sqlite'
import { db, linkedWorktreeReadOnly, writeTransaction } from './db.ts'
import { HOOK_TREE_JOB } from './hook-tree.ts'
import { pidAlive } from './process-liveness.ts'
import { teardownTerminalRunResources } from './resource-ownership.ts'
import { runAlive } from './run-alive.ts'
import { auditRunMutation, runMutationAuthority } from './run-authority.ts'
import { runLeaseState } from './run-lease.ts'

/**
 * The outer ceiling for a run and for callers waiting on one. Liveness itself
 * comes from the coordinator's kernel lease; elapsed time is not evidence that
 * a quiet worker, including one blocked on a ruling, has died.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000

/**
 * How long a pid-less `(pending)` row may sit before it is abandoned bootstrap.
 *
 * detach() inserts the reserved row, then spawns the worker, then records the
 * pid. A spawn error or a parent death in that gap leaves agent='(pending)',
 * status='running', no pid. That is not an agent run, and waiting for
 * the ordinary run lease. After this bound they are failed/harness instead.
 */
export const PENDING_BOOTSTRAP_MS = 60_000

/**
 * When the terminal outcome of a conversation chain became observable.
 *
 * A root may inherit the last child's status, but it does not inherit that
 * child's timing. Read the terminal member itself: root arithmetic can put a
 * failure hours before or after it actually happened. Until the schema holds
 * an explicit terminal timestamp, a member without latency has no supportable
 * terminal time and returns null.
 */
export function chainTerminationAt(database: Database, memberId: number): string | null {
  const member = database.query('SELECT id, parent_run_id FROM run WHERE id=?').get(memberId) as {
    id: number
    parent_run_id: number | null
  } | null
  if (!member) return null
  const rootId = member.parent_run_id ?? member.id
  const terminal = database
    .query(
      `SELECT started_at, latency_ms, status FROM run
      WHERE id=? OR parent_run_id=?
      ORDER BY turn DESC, id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { started_at: string; latency_ms: number | null; status: string } | null
  if (
    !terminal ||
    !['ok', 'failed', 'stale'].includes(terminal.status) ||
    terminal.latency_ms === null
  ) {
    return null
  }
  return new Date(Date.parse(terminal.started_at) + terminal.latency_ms).toISOString()
}

/**
 * A root inherits the terminal status of the last turn of its chain.
 *
 * Counterpart of `resolveSupersededTurn` in failover.ts, which is child-only and
 * cannot touch a root: the root is routing evidence, and giving it a terminal
 * status inserts a judgement. That is the point here, not an accident. A chain
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
 * later resumed turn finishes. The old asking-only guard was part of DEV-146's
 * stranded-root repair; the unanswered-question and last-terminal-turn guards
 * now protect that case without blocking ordinary resumed roll-up. `stopped`
 * and `stale` roots remain locked because those lifecycle decisions must not
 * be undone by a worker finishing concurrently, and a `running` root is a live
 * first turn that a stale child row must never overwrite (lens run 2277).
 *
 * The terminal turn's error and failure_kind are part of that state and travel
 * with its status. The deliberate kind exception is a stale or abandoned child: DEV-146
 * established that stranding or abandoning a chain inserts a judgement on the
 * root, while copying the child's NOT_EVIDENCE kind would erase that judgement
 * from routing. Those lifecycle outcomes therefore retain the root's kind.
 */
export function resolveRootFromLastTurn(database: Database, rootId: number): number {
  return database
    .query(
      `UPDATE run AS root
        SET status = (
          SELECT last.status FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ),
            error = (
          SELECT last.error FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ),
            failure_kind = (
          SELECT CASE
                   WHEN last.status = 'stale' OR last.failure_kind = 'abandoned'
                     THEN root.failure_kind
                   ELSE last.failure_kind
                 END
            FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ),
            pre_confinement = (
          SELECT last.pre_confinement FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ),
            confinement = (
          SELECT last.confinement FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        )
      WHERE root.id = ?
        AND root.parent_run_id IS NULL
        AND root.status IN ('asking', 'ok', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
           WHERE (owner.id = root.id OR owner.parent_run_id = root.id)
             AND q.answered_at IS NULL
        )
        AND (
          SELECT last.status FROM run last
           WHERE last.id = root.id OR last.parent_run_id = root.id
           ORDER BY last.turn DESC, last.id DESC
           LIMIT 1
        ) IN ('ok', 'failed', 'stale')`,
    )
    .run(rootId).changes
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
export type ObservedDeadRun = { id: number; reason: string }

type RunningRow = {
  id: number
  pid: number | null
  agent_pid: number | null
  agent: string
  started_at: string
}

function runningRowAlive(row: RunningRow): boolean {
  return runAlive({
    status: 'running',
    lease: runLeaseState(row.id),
    pidAlive: Boolean(row.pid && pidAlive(row.pid)),
  })
}

function deadRunReason(row: RunningRow): string {
  if (runLeaseState(row.id) === 'free') return `run lease ${row.id} is free`
  if (row.pid) return `pid ${row.pid} is not alive`
  return 'legacy run has no live pid'
}

export function reapStale(d: Database = db()): number | ObservedDeadRun[] {
  const bootstrapCutoff = new Date(Date.now() - PENDING_BOOTSTRAP_MS).toISOString()
  const rows = d
    .query(
      `SELECT id, pid, agent_pid, agent, started_at FROM run WHERE status='running' AND job<>?`,
    )
    .all(HOOK_TREE_JOB) as RunningRow[]

  const dead: number[] = []
  const abandonedBootstrap: number[] = []
  for (const r of rows) {
    // A pid-less `(pending)` row is abandoned bootstrap, not an agent run.
    // Checked before the hour cutoff so these are failed/harness rather than
    // waiting for stale/interrupted.
    if (r.agent === '(pending)') {
      if (!r.pid && r.started_at < bootstrapCutoff) abandonedBootstrap.push(r.id)
      continue
    }
    if (!runningRowAlive(r)) dead.push(r.id)
  }
  if (linkedWorktreeReadOnly) {
    return [
      ...dead.map((id) => {
        const row = rows.find((candidate) => candidate.id === id)!
        return {
          id,
          reason: deadRunReason(row),
        }
      }),
      ...abandonedBootstrap.map((id) => ({
        id,
        reason: `pending row had no pid after ${PENDING_BOOTSTRAP_MS}ms`,
      })),
    ]
  }
  if (abandonedBootstrap.length) {
    const update = d.query(
      `UPDATE run SET status='failed', failure_kind='harness',
              error='the worker process never started' WHERE id=? AND status='running'`,
    )
    for (const id of abandonedBootstrap) {
      writeTransaction(() => {
        if (update.run(id).changes !== 1) return
        const authority = runMutationAuthority(d, id)
        auditRunMutation(
          authority,
          'reap',
          `pending row had no pid after ${PENDING_BOOTSTRAP_MS}ms`,
          d,
        )
      }, d)
    }
  }
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
    // caller, charged until now to qwen-local.
    const update = d.query(
      `UPDATE run SET status='stale', failure_kind='interrupted', error=?
        WHERE id=? AND status='running'`,
    )
    for (const id of dead) {
      const row = rows.find((candidate) => candidate.id === id)!
      const vendorAlive = row.agent_pid && pidAlive(row.agent_pid)
      const surviving = vendorAlive ? `; vendor pid ${row.agent_pid} still alive` : ''
      const error = `abandoned: process gone, no terminal state recorded${surviving}`
      const reason = deadRunReason(row) + surviving
      writeTransaction(() => {
        if (update.run(error, id).changes !== 1) return
        const authority = runMutationAuthority(d, id)
        auditRunMutation(authority, 'reap', reason, d)
      }, d)
    }
  }
  const ended = [...dead, ...abandonedBootstrap]
  if (ended.length) {
    const roots = d
      .query(
        `SELECT DISTINCT COALESCE(parent_run_id, id) AS id FROM run
        WHERE id IN (${ended.map(() => '?').join(',')})`,
      )
      .all(...ended) as { id: number }[]
    for (const { id } of roots) resolveRootFromLastTurn(d, id)
    for (const id of ended) teardownTerminalRunResources(d, id)
  }
  return dead.length + abandonedBootstrap.length
}
