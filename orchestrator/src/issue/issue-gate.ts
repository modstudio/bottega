// concern: filed-issue gate verification
/** Runs the completed fix tree through the same host-side broker as worker run_gate. */

import { db } from '../database/db.ts'
import { type GateBroker, startGateBroker } from '../gate/gate-broker.ts'
import { GATE_COMMAND_TIMEOUT_MS } from '../gate/gate-decision.ts'
import {
  cancelPendingGateExecution,
  cancelUnfinishedGateExecutions,
  requestGateExecution,
} from '../gate/gate-run.ts'
import { workerGitConfigEnvironment } from '../run/run-git-guard.ts'
import { runTestWorkerEnvironment } from '../run/run-test-workers.ts'
import type { RunResult } from '../run/run-types.ts'
import { trackedWorkerEnvironment } from '../run/run-worker-home.ts'

export type IssueGateResult = {
  number: number
  ok: boolean
  text: string
  fixTreeSafeToRelease: boolean
}

export const ISSUE_GATE_WAIT_MS = GATE_COMMAND_TIMEOUT_MS + GATE_COMMAND_TIMEOUT_MS

type IssueGateBrokerStart = typeof startGateBroker
type IssueGateWait = (finished: Promise<void>, timeoutMs: number) => Promise<boolean>

async function waitForIssueGate(finished: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      finished.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type IssueGateDependencies = {
  startBroker?: IssueGateBrokerStart
  wait?: IssueGateWait
}

type GateExecutionRow = {
  exit_code: number | null
  timed_out: number | null
  output_tail: string | null
  cancelled_reason: string | null
}

function readGateExecutionRow(recordId: string): GateExecutionRow | null {
  return db()
    .query<GateExecutionRow, [string]>(
      'SELECT exit_code,timed_out,output_tail,cancelled_reason FROM gate_execution WHERE record_id=?',
    )
    .get(recordId)
}

/** What a row that stopped being pending means, whichever path noticed it. */
function finishedGateVerdict(number: number, row: GateExecutionRow): IssueGateResult {
  return {
    number,
    ok: row.exit_code === 0 && row.timed_out === 0 && row.cancelled_reason === null,
    fixTreeSafeToRelease: true,
    text:
      row.output_tail?.trim() ||
      row.cancelled_reason ||
      (row.timed_out ? 'gate timed out' : `exit ${String(row.exit_code)}`),
  }
}

/** A row that ran and was recorded, as opposed to one still waiting or running. */
function gateRowFinished(row: GateExecutionRow): boolean {
  return row.exit_code !== null || row.timed_out !== null
}

export async function runIssueGate(
  fixRun: RunResult,
  scratchDir: string,
  dependencies: IssueGateDependencies = {},
): Promise<IssueGateResult> {
  if (!fixRun.worktree)
    return {
      number: -1,
      ok: false,
      text: 'fix worktree is unavailable',
      fixTreeSafeToRelease: true,
    }
  // This run is over and its worker is gone, so any execution it still holds
  // unfinished is a dead request; one unfinished execution per run is allowed,
  // and a stale one would block the request below.
  cancelUnfinishedGateExecutions(
    fixRun.record_id,
    (execution) =>
      `issue coordinator reclaimed a dead fix worker's unfinished gate execution: run ${execution.runId} execution ${execution.number}`,
  )
  let inserted: ReturnType<typeof requestGateExecution>
  try {
    inserted = requestGateExecution(fixRun.record_id)
  } catch (error) {
    return {
      number: -1,
      ok: false,
      text:
        `issue coordinator could not request a gate for run ${fixRun.record_id}: ${String(error)}; ` +
        `that run still holds an unfinished gate execution, which must be cleared before it can be gated again`,
      fixTreeSafeToRelease: true,
    }
  }

  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  let broker: GateBroker
  try {
    broker = (dependencies.startBroker ?? startGateBroker)({
      runId: fixRun.record_id,
      scratchDir,
      environment: runTestWorkerEnvironment({
        ...workerGitConfigEnvironment(fixRun.worktree, true, 'issue-worker'),
        ...trackedWorkerEnvironment(true, true, fixRun.worktree, fixRun.record_id),
      }),
      confinement: { kind: 'host' },
      onExecutionFinish: ({ executionRecordId }) => {
        if (executionRecordId === inserted.recordId) finish()
      },
    })
  } catch (error) {
    const reason = `issue coordinator gate broker failed to start: ${String(error)}`
    cancelPendingGateExecution(inserted.recordId, reason)
    return { number: inserted.number, ok: false, text: reason, fixTreeSafeToRelease: true }
  }
  const completed = await (dependencies.wait ?? waitForIssueGate)(finished, ISSUE_GATE_WAIT_MS)
  if (!completed) {
    const reason = `issue coordinator gate did not finish within ${ISSUE_GATE_WAIT_MS}ms`
    try {
      await broker.close()
    } catch (error) {
      return {
        number: inserted.number,
        ok: false,
        text: `${reason}; gate process could not be reaped for run ${fixRun.record_id}: ${String(error)}`,
        fixTreeSafeToRelease: false,
      }
    }
    // The wait can lose a race to a gate that finished anyway; that row is a result, not a timeout.
    const row = readGateExecutionRow(inserted.recordId)
    if (!row) throw new Error(`issue coordinator gate execution ${inserted.number} disappeared`)
    if (gateRowFinished(row)) return finishedGateVerdict(inserted.number, row)
    cancelPendingGateExecution(inserted.recordId, reason)
    return { number: inserted.number, ok: false, text: reason, fixTreeSafeToRelease: true }
  }
  try {
    await broker.close()
  } catch (error) {
    const reason = `issue coordinator gate broker failed to close: ${String(error)}`
    cancelPendingGateExecution(inserted.recordId, reason)
    return { number: inserted.number, ok: false, text: reason, fixTreeSafeToRelease: false }
  }
  const row = readGateExecutionRow(inserted.recordId)
  if (!row) throw new Error(`issue coordinator gate execution ${inserted.number} disappeared`)
  return finishedGateVerdict(inserted.number, row)
}
