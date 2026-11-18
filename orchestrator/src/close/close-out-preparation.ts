// concern: asynchronous close-out preparation
/** Captures inputs needed by synchronous close-out coordination. */

import { existsSync, realpathSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { db } from '../database/db.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { conversationWorktreeSpellings } from '../resources/resource-ownership.ts'
import { shellWord, workflowCursorReference } from '../workflow/workflow-cursor-format.ts'
import {
  clearOpenCursorWorktreesAtPath,
  openCursorWorktrees,
  openCursorWorktreesAtSpellings,
} from '../workflow/workflow-cursor-worktrees.ts'
import { pointerMustClear, type ResourceTeardownResult } from './absent-tree-close-out.ts'
import type { CloseOutResult } from './close-out-report.ts'

export type CloseOutTaskFlowClient = RecordTaskFlowClient

export type CloseOutPreparation = {
  cursorWorktrees: Awaited<ReturnType<typeof openCursorWorktrees>>
  taskFlowClient?: RecordTaskFlowClient
}

export type CursorWorktreeCleanupFailure = {
  failure: string
  remedy: string
}

export function finishCursorWorktreeClear(
  result: CloseOutResult & ResourceTeardownResult,
  cleanup: CursorWorktreeCleanupFailure | null,
): CloseOutResult {
  delete result.resourceTeardownCompleted
  delete result.resourceTeardownFailed
  return cleanup
    ? { ...result, cursorCleanupFailure: cleanup.failure, cursorCleanupRemedy: cleanup.remedy }
    : result
}

export async function prepareCloseOut(
  taskFlowClient?: RecordTaskFlowClient,
): Promise<CloseOutPreparation> {
  return { cursorWorktrees: await openCursorWorktrees(), taskFlowClient }
}

export function conversationRootAndWorktree(runId: string): {
  rootRecordId: string
  worktree: string | null
} {
  const row = db()
    .query(
      'SELECT COALESCE(parent_run_record_id,record_id) root_record_id,worktree FROM run WHERE record_id=?',
    )
    .get(runId) as { root_record_id: string; worktree: string | null } | null
  if (!row) throw new Error(`no run ${runId}`)
  const root = db().query('SELECT worktree FROM run WHERE record_id=?').get(row.root_record_id) as {
    worktree: string | null
  } | null
  return { rootRecordId: row.root_record_id, worktree: row.worktree ?? root?.worktree ?? null }
}

export function prepareCursorWorktreeClear(
  runId: string,
  preparation: CloseOutPreparation,
): (
  result: CloseOutResult & ResourceTeardownResult,
) => Promise<CursorWorktreeCleanupFailure | null> {
  const root = conversationRootAndWorktree(runId)
  const worktree = root.worktree
  const spellings = conversationWorktreeSpellings(db(), root.rootRecordId)
  if (worktree && existsSync(worktree)) {
    const identity = realpathSync(worktree)
    const cursorSpellings = preparation.cursorWorktrees.flatMap((cursor) => {
      try {
        return realpathSync(cursor.worktree) === identity ? [cursor.worktree] : []
      } catch {
        return []
      }
    })
    spellings.set(worktree, [
      ...new Set([...(spellings.get(worktree) ?? [worktree]), ...cursorSpellings]),
    ])
  }
  return async (result) => {
    if (
      !result.worktree ||
      !pointerMustClear(result.outcome, result.worktree) ||
      result.resourceTeardownFailed
    )
      return null
    const capturedSpellings = spellings.get(result.worktree) ?? [result.worktree]
    try {
      await clearOpenCursorWorktreesAtPath(capturedSpellings, db(), preparation.taskFlowClient)
      return null
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const spellingSet = new Set(capturedSpellings)
      let uncleared = preparation.cursorWorktrees.filter((cursor) =>
        spellingSet.has(cursor.worktree),
      )
      try {
        uncleared = openCursorWorktreesAtSpellings(capturedSpellings, db())
      } catch {
        // The preparation snapshot still names every cursor that may need manual repair.
      }
      const cursorNames = uncleared.map((cursor) => `cursor ${cursor.number}`).join(', ')
      const remedy = uncleared
        .map(
          (cursor) =>
            `${PLATFORM_SLUG} workflow step ${shellWord(cursor.workflow)}` +
            `${workflowCursorReference(cursor.number, cursor.project).cli}` +
            ` --arg ${shellWord('worktree=<tree>')}`,
        )
        .join('; ')
      const failure = renderRefusal(
        refusal(
          `the tree at ${result.worktree} was ${result.outcome} but the worktree pointers for ${cursorNames || 'the affected cursors'} could not be cleared: ${detail}`,
          {
            kind: 'edit',
            text: remedy || `rebind each affected cursor with --arg worktree=<tree>`,
          },
        ),
      ).replace('\n', '; ')
      return { failure, remedy: remedy || `rebind each affected cursor with --arg worktree=<tree>` }
    }
  }
}
