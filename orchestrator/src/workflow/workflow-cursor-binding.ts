// concern: workflow cursor argument binding
/** Binds lifecycle-discovered branch and worktree handles through the cursor's stage service. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, writeTransaction } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { TASK_FLOW_OPEN_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { resolveCursorArguments } from './workflow-cursor-arguments.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'

export type CursorBranchBindingDecision =
  | { action: 'fill' }
  | { action: 'no-op' }
  | { action: 'rebind' }
  | { action: 'refuse'; pullRequestNumber: number }

/** Decide whether a run-discovered branch may replace the cursor's current branch. */
export function decideCursorBranchBinding(input: {
  currentBranch: string | null
  pullRequestNumber: number | null
  runBranch: string
}): CursorBranchBindingDecision {
  if (!input.currentBranch?.trim()) return { action: 'fill' }
  if (input.currentBranch === input.runBranch) return { action: 'no-op' }
  return input.pullRequestNumber === null
    ? { action: 'rebind' }
    : { action: 'refuse', pullRequestNumber: input.pullRequestNumber }
}

export type CursorArgumentBindingResult =
  | { action: 'unbound' | 'no-op' | 'updated' }
  | { action: 'refused'; warning: string }

export type TaskKeyWorktreeBindingResult =
  | { action: 'none' | 'bound' }
  | { action: 'ambiguous'; cursors: number[] }

function pullRequestNumberForBranch(
  database: Database,
  project: string,
  branch: string,
): number | null {
  const row = database
    .query<{ pr_number: number }, [string, string]>(
      `SELECT pr_number FROM landing_triage_snapshot
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND branch=? AND pr_number IS NOT NULL
       ORDER BY at DESC LIMIT 1`,
    )
    .get(project, branch)
  return row?.pr_number ?? null
}

function branchRefusalWarning(input: {
  cursor: number
  project: string
  workflow: string
  currentBranch: string
  runBranch: string
  pullRequestNumber: number
}): string {
  const reference = workflowCursorReference(input.cursor, input.project).cli
  return (
    `workflow cursor ${input.cursor} kept branch ${input.currentBranch}: run branch ${input.runBranch} ` +
    `cannot replace it after pull request #${input.pullRequestNumber} was opened; abandon the cursor with ` +
    `${PLATFORM_SLUG} workflow abandon ${input.workflow}${reference} --reason "<why>"`
  )
}

/** Merge lifecycle-discovered arguments and persist them through the task-flow stage-update port. */
export async function bindCursorArguments(
  input: {
    cursorRecordId: string | null
    branch?: string | null
    worktree?: string | null
  },
  database: Database = db(),
  client?: RecordTaskFlowClient,
): Promise<CursorArgumentBindingResult> {
  if (!input.cursorRecordId) return { action: 'unbound' }
  const row = await taskFlowReadStore(database, client).stageByRecordId(input.cursorRecordId)
  if (!row) return { action: 'unbound' }
  const stored = JSON.parse(row.args) as Record<string, string>
  const supplied: Record<string, string> = {}
  if (input.worktree?.trim()) supplied.worktree = input.worktree

  let refusal: Extract<CursorArgumentBindingResult, { action: 'refused' }> | null = null
  if (input.branch?.trim()) {
    const currentBranch = stored.branch?.trim() || null
    const pullRequestNumber = currentBranch
      ? pullRequestNumberForBranch(database, row.project, currentBranch)
      : null
    const decision = decideCursorBranchBinding({
      currentBranch,
      pullRequestNumber,
      runBranch: input.branch,
    })
    if (decision.action === 'refuse') {
      refusal = {
        action: 'refused',
        warning: branchRefusalWarning({
          cursor: row.id,
          project: row.project,
          workflow: row.workflow_slug,
          currentBranch: currentBranch!,
          runBranch: input.branch,
          pullRequestNumber: decision.pullRequestNumber,
        }),
      }
    } else if (decision.action !== 'no-op') supplied.branch = input.branch
  }

  if (Object.keys(supplied).length === 0) return refusal ?? { action: 'no-op' }
  const resolved = resolveCursorArguments(row, supplied, database)
  if (resolved.encoded === row.args && resolved.closed === row.closed)
    return refusal ?? { action: 'no-op' }
  const payload: TaskFlowIntentInput<'stage-update'> = {
    requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
    stages: [
      {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          arguments: resolved.args,
          closedStepNotes: JSON.parse(resolved.closed),
          updatedAt: resolved.updatedAt,
        },
      },
    ],
  }
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    payload,
    taskFlowWriteTarget(row.project, database),
    client,
  )
  writeTransaction(
    () => taskFlowLocalStore(database).write('stage-update', payload, hosted),
    database,
  )
  return refusal ?? { action: 'updated' }
}

/** Read one run's recorded lifecycle handles and bind them to its cursor, if any. */
export async function bindRecordedRunCursorArguments(
  runRecordId: string,
  database: Database = db(),
  client?: RecordTaskFlowClient,
): Promise<CursorArgumentBindingResult> {
  const run = database
    .query<
      {
        cursor_record_id: string | null
        branch: string | null
        job: string
        worktree: string | null
      },
      [string]
    >('SELECT cursor_record_id,branch,job,worktree FROM run WHERE record_id=?')
    .get(runRecordId)
  if (!run) return { action: 'unbound' }
  if (JOBS[run.job]?.needs.writesRepo !== true) return { action: 'no-op' }
  return bindCursorArguments(
    {
      cursorRecordId: run.cursor_record_id,
      branch: run.branch,
      worktree: run.worktree,
    },
    database,
    client,
  )
}

/** Bind a task-created tree only when the project and key select one open cursor. */
export async function bindTaskKeyWorktree(
  input: { project: string; key: string; worktree: string },
  database: Database = db(),
  client?: RecordTaskFlowClient,
): Promise<TaskKeyWorktreeBindingResult> {
  const rows = (
    await taskFlowReadStore(database, client).listStages({
      project: input.project,
      states: TASK_FLOW_OPEN_STAGE_STATES,
    })
  ).filter((row) => row.workflow_key === input.key)
  if (rows.length === 0) return { action: 'none' }
  if (rows.length > 1) return { action: 'ambiguous', cursors: rows.map((row) => row.id) }
  await bindCursorArguments(
    { cursorRecordId: rows[0]!.record_id, worktree: input.worktree },
    database,
    client,
  )
  return { action: 'bound' }
}
