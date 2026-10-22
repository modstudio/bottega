// concern: filed-issue gate verification
/** Runs the completed fix tree through the same host-side broker as worker run_gate. */

import { db } from '../database/db.ts'
import { type GateBroker, startGateBroker } from '../gate/gate-broker.ts'
import { GATE_COMMAND_TIMEOUT_MS } from '../gate/gate-decision.ts'
import { cancelPendingGateExecution, requestGateExecution } from '../gate/gate-run.ts'
import { workerGitConfigEnvironment } from '../run/run-git-guard.ts'
import { runTestWorkerEnvironment } from '../run/run-test-workers.ts'
import type { RunResult } from '../run/run-types.ts'
import { trackedWorkerEnvironment } from '../run/run-worker-home.ts'

export type IssueGateResult = {
  id: number
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

export async function runIssueGate(
  fixRun: RunResult,
  scratchDir: string,
  dependencies: IssueGateDependencies = {},
): Promise<IssueGateResult> {
  if (!fixRun.worktree)
    return {
      id: -1,
      ok: false,
      text: 'fix worktree is unavailable',
      fixTreeSafeToRelease: true,
    }
  const inserted = requestGateExecution(fixRun.record_id)

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
      onExecutionFinish: ({ executionId }) => {
        if (executionId === inserted.id) finish()
      },
    })
  } catch (error) {
    const reason = `issue coordinator gate broker failed to start: ${String(error)}`
    cancelPendingGateExecution(inserted.id, reason)
    return { id: inserted.id, ok: false, text: reason, fixTreeSafeToRelease: true }
  }
  const completed = await (dependencies.wait ?? waitForIssueGate)(finished, ISSUE_GATE_WAIT_MS)
  if (!completed) {
    const reason = `issue coordinator gate did not finish within ${ISSUE_GATE_WAIT_MS}ms`
    try {
      await broker.close()
    } catch (error) {
      return {
        id: inserted.id,
        ok: false,
        text: `${reason}; gate process could not be reaped for run ${fixRun.record_id}: ${String(error)}`,
        fixTreeSafeToRelease: false,
      }
    }
    cancelPendingGateExecution(inserted.id, reason)
    return { id: inserted.id, ok: false, text: reason, fixTreeSafeToRelease: true }
  }
  try {
    await broker.close()
  } catch (error) {
    const reason = `issue coordinator gate broker failed to close: ${String(error)}`
    cancelPendingGateExecution(inserted.id, reason)
    return { id: inserted.id, ok: false, text: reason, fixTreeSafeToRelease: false }
  }
  const row = db()
    .query<
      {
        exit_code: number | null
        timed_out: number | null
        output_tail: string | null
        cancelled_reason: string | null
      },
      [number]
    >('SELECT exit_code,timed_out,output_tail,cancelled_reason FROM gate_execution WHERE id=?')
    .get(inserted.id)
  if (!row) throw new Error(`issue coordinator gate execution ${inserted.id} disappeared`)
  const ok = row.exit_code === 0 && row.timed_out === 0 && row.cancelled_reason === null
  return {
    id: inserted.id,
    ok,
    fixTreeSafeToRelease: true,
    text:
      row.output_tail?.trim() ||
      row.cancelled_reason ||
      (row.timed_out ? 'gate timed out' : `exit ${String(row.exit_code)}`),
  }
}
