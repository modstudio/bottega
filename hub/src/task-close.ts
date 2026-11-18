import { type BranchPruneResult, pruneTaskBranches, releaseTaskClaims } from './orch.ts'
import { closeTask, showTask } from './task.ts'
import type { Attribution } from './task-attribution.ts'
import {
  taskBranchPruneResidue,
  taskClaimReleaseResidue,
  taskCursorAbandonResidue,
} from './task-closed-residue.ts'
import type { TaskScope } from './task-identity.ts'
import type { TaskRow } from './task-row.ts'
import {
  type AbandonedTaskCursor,
  abandonPlannedTaskCursors,
  type openTaskWorkflowCursors,
  planOpenTaskCursorClose,
  type TaskCursorAbandon,
  TaskCursorAbandonError,
} from './task-workflow-cursors.ts'

export async function closeThenPrune(
  key: string,
  scope: TaskScope,
  keepBranches: boolean,
  abandonReason: string | undefined,
  attribution: Attribution,
  confirm: string,
  dependencies: {
    close?: (
      key: string,
      scope: TaskScope,
      attribution: Attribution,
      options: { abandonReason?: string; confirm: string },
    ) => Promise<TaskRow>
    prune?: typeof pruneTaskBranches
    releaseClaims?: typeof releaseTaskClaims
    listCursors?: typeof openTaskWorkflowCursors
    abandonCursor?: TaskCursorAbandon
    callingSession?: string | null
    project?: (key: string, scope: TaskScope) => string
    cursorAbandoned?: (cursor: AbandonedTaskCursor) => void
  } = {},
): Promise<{ closed: TaskRow; pruned: BranchPruneResult | null }> {
  const plan = await planOpenTaskCursorClose(
    dependencies.project?.(key, scope) ?? showTaskProject(key, scope),
    key,
    'done',
    {
      list: dependencies.listCursors,
      abandon: dependencies.abandonCursor,
      callingSession: dependencies.callingSession,
      onAbandoned: dependencies.cursorAbandoned,
    },
  )
  const closed = dependencies.close
    ? await dependencies.close(key, scope, attribution, { abandonReason, confirm })
    : await closeTask(key, scope, attribution, { abandonReason })
  try {
    await abandonPlannedTaskCursors(plan)
  } catch (error) {
    if (!(error instanceof TaskCursorAbandonError)) throw error
    throw taskCursorAbandonResidue(closed, plan.status, error.cursor, error.cause)
  }
  try {
    await (dependencies.releaseClaims ?? releaseTaskClaims)(closed.project, closed.key)
  } catch (error) {
    throw taskClaimReleaseResidue(closed, error)
  }
  if (keepBranches) return { closed, pruned: null }
  try {
    return {
      closed,
      pruned: await (dependencies.prune ?? pruneTaskBranches)(closed.project, closed.key),
    }
  } catch (error) {
    throw taskBranchPruneResidue(closed, error)
  }
}

function showTaskProject(key: string, scope: TaskScope): string {
  return showTask(key, scope).task.project
}
