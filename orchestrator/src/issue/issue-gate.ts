// concern: filed-issue gate verification
/** Runs the completed fix tree through the same host-side broker as worker run_gate. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso } from '../database/db.ts'
import { startGateBroker } from '../gate/gate-broker.ts'
import { trackedRecipeEnvironment } from '../recipe/tracked-recipe.ts'
import { runTestWorkerEnvironment } from '../run/run-test-workers.ts'
import type { RunResult } from '../run/run-types.ts'

export type IssueGateResult = { id: number; ok: boolean; text: string }

export async function runIssueGate(
  fixRun: RunResult,
  scratchDir: string,
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
  const broker = startGateBroker({
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
  await finished
  await broker.close()
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
