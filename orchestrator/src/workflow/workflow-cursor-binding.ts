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
import type { TaskFlowIntentInput, TaskFlowStageCursorRow } from './task-flow-store-types.ts'
import {
  declaredCursorArguments,
  rebindableCursorArguments,
  resolveCursorArguments,
} from './workflow-cursor-arguments.ts'
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
  | { action: 'refused'; cursor: number; warning: string }

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

function branchConflictWarning(input: {
  cursor: number
  project: string
  workflow: string
  currentBranch: string
  runBranch: string
}): string {
  const reference = workflowCursorReference(input.cursor, input.project).cli
  return (
    `workflow cursor ${input.cursor} kept branch ${input.currentBranch}: run branch ${input.runBranch} ` +
    `conflicts with the workflow's non-rebindable branch argument; abandon the cursor with ` +
    `${PLATFORM_SLUG} workflow abandon ${input.workflow}${reference} --reason "<why>"`
  )
}

function bindingFailureWarning(cursor: number, error: unknown): string {
  return `workflow cursor ${cursor} argument binding failed: ${String((error as Error)?.message ?? error)}`
}

function discoveredBranchBinding(
  row: TaskFlowStageCursorRow,
  stored: Record<string, string>,
  runBranch: string | null | undefined,
  database: Database,
): { branch?: string; refusal?: Extract<CursorArgumentBindingResult, { action: 'refused' }> } {
  if (!runBranch?.trim()) return {}
  const currentBranch = stored.branch?.trim() || null
  const pullRequestNumber = currentBranch
    ? pullRequestNumberForBranch(database, row.project, currentBranch)
    : null
  const decision = decideCursorBranchBinding({ currentBranch, pullRequestNumber, runBranch })
  if (decision.action === 'refuse') {
    return {
      refusal: {
        action: 'refused',
        warning: branchRefusalWarning({
          cursor: row.id,
          project: row.project,
          workflow: row.workflow_slug,
          currentBranch: currentBranch!,
          runBranch,
          pullRequestNumber: decision.pullRequestNumber,
        }),
      },
    }
  }
  if (decision.action === 'rebind' && !rebindableCursorArguments(row, database).has('branch')) {
    return {
      refusal: {
        action: 'refused',
        warning: branchConflictWarning({
          cursor: row.id,
          project: row.project,
          workflow: row.workflow_slug,
          currentBranch: currentBranch!,
          runBranch,
        }),
      },
    }
  }
  return decision.action === 'no-op' ? {} : { branch: runBranch }
}

function latestCursorImplementBranch(database: Database, cursorRecordId: string): string | null {
  return (
    database
      .query<{ branch: string }, [string]>(
        `WITH latest_chain AS (
           SELECT root.record_id
             FROM run root
            WHERE root.parent_run_record_id IS NULL
              AND root.job='implement'
              AND EXISTS (
                SELECT 1 FROM run bound
                 WHERE (bound.record_id=root.record_id OR bound.parent_run_record_id=root.record_id)
                   AND bound.cursor_record_id=?
              )
            ORDER BY root.number DESC
            LIMIT 1
         )
         SELECT COALESCE(turn.branch,turn.branch_kept) AS branch
           FROM run turn JOIN latest_chain
             ON turn.record_id=latest_chain.record_id
             OR turn.parent_run_record_id=latest_chain.record_id
          ORDER BY turn.turn DESC,turn.number DESC
          LIMIT 1`,
      )
      .get(cursorRecordId)?.branch ?? null
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
  try {
    const stored = JSON.parse(row.args) as Record<string, string>
    const declared = declaredCursorArguments(row, database)
    const supplied: Record<string, string> = {}
    if (declared.has('worktree') && input.worktree?.trim()) supplied.worktree = input.worktree

    if (declared.has('branch')) {
      const branch = discoveredBranchBinding(row, stored, input.branch, database)
      if (branch.refusal) return branch.refusal
      if (branch.branch) supplied.branch = branch.branch
    }

    if (Object.keys(supplied).length === 0) return { action: 'no-op' }
    const resolved = resolveCursorArguments(row, supplied, database)
    if (resolved.encoded === row.args && resolved.closed === row.closed) return { action: 'no-op' }
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
    return { action: 'updated' }
  } catch (error) {
    return { action: 'refused', warning: bindingFailureWarning(row.id, error) }
  }
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
  const branch = run.cursor_record_id
    ? latestCursorImplementBranch(database, run.cursor_record_id)
    : null
  return bindCursorArguments(
    {
      cursorRecordId: run.cursor_record_id,
      branch,
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
  const row = rows[0]!
  try {
    const result = await bindCursorArguments(
      { cursorRecordId: row.record_id, worktree: input.worktree },
      database,
      client,
    )
    if (result.action === 'refused')
      return { action: 'refused', cursor: row.id, warning: result.warning }
  } catch (error) {
    return { action: 'refused', cursor: row.id, warning: bindingFailureWarning(row.id, error) }
  }
  return { action: 'bound' }
}
