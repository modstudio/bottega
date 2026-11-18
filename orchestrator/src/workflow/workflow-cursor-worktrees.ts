// concern: workflow cursor worktree ownership
/** Reads open cursor worktrees and clears pointers to trees after removal. */

import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput, TaskFlowOpenStageWorktreeRow } from './task-flow-store-types.ts'
import type { ArgumentReboundEvent, CursorTrailEntry } from './workflow-cursor-trail.ts'

export type OpenCursorWorktree = {
  number: number
  workflow: string
  project: string
  worktree: string
}

export type CursorWorktreeTaskFlowClient = RecordTaskFlowClient

type OpenCursorWorktreeRow = TaskFlowOpenStageWorktreeRow & { worktree: string }

/** Read the claim handles carried by one cursor without trusting stored argument JSON. */
function workflowCursorStoredArgs(args: string): Record<string, unknown> | null {
  try {
    return JSON.parse(args) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Read the branch and worktree carried by one cursor as normalized optional handles. */
export function workflowCursorBranchAndWorktree(args: string): {
  branch: string | null
  worktree: string | null
} {
  const parsed = workflowCursorStoredArgs(args)
  const handle = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null
  return {
    branch: handle(parsed?.branch),
    worktree: handle(parsed?.worktree),
  }
}

export function workflowCursorClaimHandles(args: string): string[] {
  const handles = workflowCursorBranchAndWorktree(args)
  return [handles.worktree, handles.branch].filter((value): value is string => value !== null)
}

/** Read normalized open cursor worktrees in the store's project/number order. */
async function readOpenCursorWorktreeRows(
  database: Database,
  client?: RecordTaskFlowClient,
): Promise<OpenCursorWorktreeRow[]> {
  return (await taskFlowReadStore(database, client).openStageWorktrees()).flatMap((row) => {
    const worktree = workflowCursorBranchAndWorktree(row.args).worktree
    return worktree === null ? [] : [{ ...row, worktree }]
  })
}

function publicOpenCursorWorktree(row: OpenCursorWorktreeRow): OpenCursorWorktree {
  return {
    number: row.number,
    workflow: row.workflow,
    project: row.project,
    worktree: row.worktree,
  }
}

/** Select normalized open cursor worktrees whose handle uses a captured spelling. */
async function readOpenCursorWorktreeRowsAtSpellings(
  capturedSpellings: readonly string[],
  database: Database,
  client?: RecordTaskFlowClient,
): Promise<OpenCursorWorktreeRow[]> {
  const spellings = new Set(capturedSpellings)
  return (await readOpenCursorWorktreeRows(database, client)).filter((row) =>
    spellings.has(row.worktree),
  )
}

export async function openCursorWorktrees(
  database: Database = db(),
  client?: RecordTaskFlowClient,
): Promise<OpenCursorWorktree[]> {
  return (await readOpenCursorWorktreeRows(database, client)).map(publicOpenCursorWorktree)
}

/** Read open cursors whose stored worktree uses a captured tree spelling. */
export async function openCursorWorktreesAtSpellings(
  capturedSpellings: readonly string[],
  database: Database = db(),
  client?: RecordTaskFlowClient,
): Promise<OpenCursorWorktree[]> {
  return (await readOpenCursorWorktreeRowsAtSpellings(capturedSpellings, database, client)).map(
    publicOpenCursorWorktree,
  )
}

/** Clear open cursor claims that point at a tree which has just been removed. */
export async function clearOpenCursorWorktreesAtPath(
  capturedSpellings: readonly string[],
  database: Database = db(),
  client?: RecordTaskFlowClient,
): Promise<number> {
  const rows = await readOpenCursorWorktreeRowsAtSpellings(capturedSpellings, database, client)
  for (const row of rows) {
    const args = JSON.parse(row.args) as Record<string, string>
    const oldValue = args.worktree!
    delete args.worktree
    const at = nowIso()
    const closed = JSON.parse(row.closed) as CursorTrailEntry[]
    const rebound: ArgumentReboundEvent = {
      event: 'argument-rebound',
      name: 'worktree',
      oldValue,
      newValue: '',
      at,
    }
    closed.push(rebound)
    const payload: TaskFlowIntentInput<'stage-update'> = {
      requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
      stages: [
        {
          id: row.record_id,
          expectedRevision: row.revision,
          values: { arguments: args, closedStepNotes: closed, updatedAt: at },
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
  }
  return rows.length
}
