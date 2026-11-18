import { pruneTaskBranches, releaseTaskClaims } from './orch.ts'
import { closeTask, showTask } from './task.ts'
import type { Attribution } from './task-attribution.ts'
import type { TaskScope } from './task-identity.ts'
import type { TaskRow } from './task-row.ts'
import {
  type AbandonedTaskCursor,
  abandonPlannedTaskCursors,
  type openTaskWorkflowCursors,
  planOpenTaskCursorClose,
  type TaskCursorAbandon,
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
) {
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
  let abandoned: AbandonedTaskCursor[] = []
  try {
    abandoned = await abandonPlannedTaskCursors(plan)
  } catch (error) {
    return {
      closed,
      abandoned,
      abandonError: error as Error,
      releaseError: null,
      pruned: null,
      pruneError: null,
    }
  }
  try {
    await (dependencies.releaseClaims ?? releaseTaskClaims)(closed.project, closed.key)
  } catch (error) {
    return {
      closed,
      abandoned,
      abandonError: null,
      releaseError: error as Error,
      pruned: null,
      pruneError: null,
    }
  }
  if (keepBranches)
    return {
      closed,
      abandoned,
      abandonError: null,
      releaseError: null,
      pruned: null,
      pruneError: null,
    }
  try {
    return {
      closed,
      abandoned,
      abandonError: null,
      releaseError: null,
      pruned: await (dependencies.prune ?? pruneTaskBranches)(closed.project, closed.key),
      pruneError: null,
    }
  } catch (error) {
    return {
      closed,
      abandoned,
      abandonError: null,
      releaseError: null,
      pruned: null,
      pruneError: error as Error,
    }
  }
}

function showTaskProject(key: string, scope: TaskScope): string {
  return showTask(key, scope).task.project
}
