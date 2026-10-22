// concern: filed-issue gate verification
/** Runs the completed fix tree through the same host-side broker as worker run_gate. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso } from '../database/db.ts'
import { type GateBroker, startGateBroker } from '../gate/gate-broker.ts'
import { GATE_COMMAND_TIMEOUT_MS } from '../gate/gate-decision.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { runTestWorkerEnvironment } from '../run/run-test-workers.ts'
import type { RunResult } from '../run/run-types.ts'

export type IssueGateResult = { id: number; ok: boolean; text: string }

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

function cancelIssueGate(id: number, reason: string): void {
  db()
    .query(
      `UPDATE gate_execution SET finished_at=?,exit_code=-1,timed_out=0,elapsed_ms=0,
       cancelled_reason=? WHERE id=?`,
    )
    .run(nowIso(), reason, id)
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
  if (!fixRun.worktree) return { id: -1, ok: false, text: 'fix worktree is unavailable' }
  const inserted = db()
    .query<{ id: number }, [string, string, string]>(
      'INSERT INTO gate_execution (record_id,run_record_id,requested_at) VALUES (?,?,?) RETURNING id',
    )
    .get(newRecordId(), fixRun.record_id, nowIso())
  if (!inserted) throw new Error('issue coordinator gate execution was not inserted')

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
        ...trackedRecipeEnvironment(fixRun.record_id),
        ORCH_MAIN_CHECKOUT: fixRun.worktree.repoRoot,
      }),
      onExecutionFinish: ({ executionId }) => {
        if (executionId === inserted.id) finish()
      },
    })
  } catch (error) {
    const reason = `issue coordinator gate broker failed to start: ${String(error)}`
    cancelIssueGate(inserted.id, reason)
    return { id: inserted.id, ok: false, text: reason }
  }
  const completed = await (dependencies.wait ?? waitForIssueGate)(finished, ISSUE_GATE_WAIT_MS)
  if (!completed) {
    const reason = `issue coordinator gate did not finish within ${ISSUE_GATE_WAIT_MS}ms`
    try {
      await broker.close()
    } catch {
      // The bounded coordinator result remains authoritative even if broker shutdown fails.
    } finally {
      cancelIssueGate(inserted.id, reason)
    }
    return { id: inserted.id, ok: false, text: reason }
  }
  try {
    await broker.close()
  } catch (error) {
    const reason = `issue coordinator gate broker failed to close: ${String(error)}`
    cancelIssueGate(inserted.id, reason)
    return { id: inserted.id, ok: false, text: reason }
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
    text:
      row.output_tail?.trim() ||
      row.cancelled_reason ||
      (row.timed_out ? 'gate timed out' : `exit ${String(row.exit_code)}`),
  }
}
