// concern: task workflow cursor close
/** Lists cursors and refuses live work before close, then abandons them after close succeeds. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type OpenWorkflowCursor,
  OpenWorkflowCursorListSchema,
  WorkflowAbandonResultSchema,
} from '../../shared/orch-contract.ts'
import { callerSession } from './caller-session.ts'
import { parseOrchestratorJson } from './orch.ts'

export type OpenTaskWorkflowCursor = OpenWorkflowCursor

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
  const cursors = (await (dependencies.list ?? openTaskWorkflowCursors)(project)).filter(
    (cursor) =>
      cursor.workflow_key?.toUpperCase() === key.toUpperCase() &&
      (calling === null || cursor.session_id !== calling),
  )
  const live = cursors.flatMap((cursor) => cursor.live_runs.map((run) => ({ cursor, run })))
  if (live.length) {
    const details = live
      .map(
        ({ cursor, run }) =>
          `cursor ${cursor.id} has live run ${run.number} [${run.record_id}]; clear it with: ${PLATFORM_SLUG} run stop ${run.number}`,
      )
      .join('\n')
    throw new Error(`refusing to close task ${key} while its cursor has live work:\n${details}`)
  }
  return {
    key,
    status,
    cursors,
    onAbandoned: dependencies.onAbandoned,
    abandon:
      dependencies.abandon ??
      ((cursor, reason, ownerSession) =>
        abandonTaskWorkflowCursor(project, cursor, reason, ownerSession)),
  }
}

export async function abandonPlannedTaskCursors(
  plan: TaskCursorClosePlan,
): Promise<AbandonedTaskCursor[]> {
  const reason = `task ${plan.key} closed (${plan.status})`
  const abandoned: AbandonedTaskCursor[] = []
  for (const cursor of plan.cursors) {
    await plan.abandon(cursor, reason, cursor.session_id ?? undefined)
    const result = { number: cursor.id, workflow: cursor.workflow_slug, reason }
    abandoned.push(result)
    plan.onAbandoned?.(result)
  }
  return abandoned
}
