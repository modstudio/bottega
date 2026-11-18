// concern: asynchronous close-out preparation
/** Captures inputs needed by synchronous close-out coordination. */

import { existsSync, realpathSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { db } from '../database/db.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { conversationWorktreeSpellings } from '../resources/resource-ownership.ts'
import {
  clearOpenCursorWorktreesAtPath,
  openCursorWorktrees,
} from '../workflow/workflow-cursor-worktrees.ts'

export type CloseOutTaskFlowClient = RecordTaskFlowClient

export type CloseOutPreparation = {
  cursorWorktrees: Awaited<ReturnType<typeof openCursorWorktrees>>
  taskFlowClient?: RecordTaskFlowClient
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
): (result: { worktree: string | null; outcome: string }) => Promise<string | null> {
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
    if (!result.worktree || !['released', 'absent'].includes(result.outcome)) return null
    try {
      await clearOpenCursorWorktreesAtPath(
        result.worktree,
        db(),
        preparation.taskFlowClient,
        spellings.get(result.worktree) ?? [result.worktree],
      )
      return null
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return renderRefusal(
        refusal(
          `the tree at ${result.worktree} was ${result.outcome} but the cursor worktree pointers at it could not be cleared: ${detail}`,
          {
            kind: 'edit',
            text: `rerun ${PLATFORM_SLUG} tree remove ${result.worktree} to retry, or pass --arg worktree=<tree> on the cursor`,
          },
        ),
      ).replace('\n', '; ')
    }
  }
}
