// concern: task workflow cursor close
/** Lists cursors and refuses live work before close, then abandons them after close succeeds. */

import {
  OpenWorkflowCursorListSchema,
  WorkflowAbandonResultSchema,
} from '../../shared/orch-contract.ts'
import { callerSession } from './caller-session.ts'
import { parseOrchestratorJson } from './orch.ts'
import { taskCursorAbandonResidue } from './task-closed-residue.ts'
import { decideTaskCursorClose, type OpenTaskWorkflowCursor } from './task-cursor-close-decision.ts'
import type { TaskRow } from './task-row.ts'

export type { OpenTaskWorkflowCursor } from './task-cursor-close-decision.ts'

export type AbandonedTaskCursor = { number: number; workflow: string; reason: string }

export const openTaskWorkflowCursors = (project: string): Promise<OpenTaskWorkflowCursor[]> =>
  parseOrchestratorJson(
    ['workflow', 'cursors', '--project', project, '--json'],
    OpenWorkflowCursorListSchema,
  )

const abandonTaskWorkflowCursor = (
  project: string,
  cursor: OpenTaskWorkflowCursor,
  reason: string,
  ownerSession?: string,
): Promise<string> =>
  parseOrchestratorJson(
    [
      'workflow',
      'abandon',
      cursor.workflow_slug,
      '--cursor',
      String(cursor.id),
      '--project',
      cursor.project ?? project,
      '--reason',
      reason,
      ...(ownerSession ? ['--owner-session', ownerSession] : []),
      '--json',
    ],
    WorkflowAbandonResultSchema,
  )

export type TaskCursorAbandon = (
  cursor: OpenTaskWorkflowCursor,
  reason: string,
  ownerSession?: string,
) => Promise<unknown>

export type TaskCursorClosePlan = {
  key: string
  status: string
  cursors: OpenTaskWorkflowCursor[]
  onAbandoned?: (cursor: AbandonedTaskCursor) => void
  abandon: TaskCursorAbandon
}

export async function planOpenTaskCursorClose(
  project: string,
  key: string,
  status: string,
  dependencies: {
    list?: typeof openTaskWorkflowCursors
    abandon?: TaskCursorAbandon
    callingSession?: string | null
    onAbandoned?: (cursor: AbandonedTaskCursor) => void
  } = {},
): Promise<TaskCursorClosePlan> {
  const calling =
    dependencies.callingSession === undefined ? callerSession() : dependencies.callingSession
  const decision = decideTaskCursorClose({
    key,
    cursors: await (dependencies.list ?? openTaskWorkflowCursors)(project),
    callingSession: calling,
  })
  if (decision.action === 'refuse') throw new Error(decision.reason)
  return {
    key,
    status,
    cursors: decision.cursors,
    onAbandoned: dependencies.onAbandoned,
    abandon:
      dependencies.abandon ??
      ((cursor, reason, ownerSession) =>
        abandonTaskWorkflowCursor(project, cursor, reason, ownerSession)),
  }
}

export async function abandonPlannedTaskCursors(
  plan: TaskCursorClosePlan,
  closed: TaskRow,
): Promise<void> {
  const reason = `task ${plan.key} closed (${plan.status})`
  for (const [index, cursor] of plan.cursors.entries()) {
    try {
      await plan.abandon(cursor, reason, cursor.session_id ?? undefined)
    } catch (error) {
      throw taskCursorAbandonResidue(closed, plan.status, plan.cursors.slice(index), error)
    }
    const result = { number: cursor.id, workflow: cursor.workflow_slug, reason }
    try {
      plan.onAbandoned?.(result)
    } catch (error) {
      const remaining = plan.cursors.slice(index + 1)
      if (!remaining.length) throw error
      throw taskCursorAbandonResidue(closed, plan.status, remaining, error)
    }
  }
}
