// concern: session epic work
/** Gathers the epic queue surface for one live session without changing claims. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import {
  TASK_FLOW_OPEN_STAGE_STATES,
  TASK_FLOW_STAGE_STATES,
} from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { type TaskReadRow, taskReader } from '../workflow/task-read-port.ts'
import { type ChildTaskFact, childQueueState } from '../workflow/workflow-child-queue.ts'

function ancestors(key: string, tasks: readonly TaskReadRow[]): string[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const result: string[] = []
  let parent = byKey.get(key)?.parent_key ?? null
  while (parent) {
    result.push(parent)
    parent = byKey.get(parent)?.parent_key ?? null
  }
  return result
}

async function taskFacts(database: Database, project: string, tasks: readonly TaskReadRow[]) {
  const composed = new Set(
    (
      await taskFlowReadStore(database).listStages({
        project,
        states: [...TASK_FLOW_STAGE_STATES],
      })
    ).map(({ workflow_key }) => workflow_key),
  )
  const claims = database
    .query<
      { subject_kind: string; subject_value: string; holder_session: string; taken_at: string },
      [string, string]
    >(
      `SELECT subject_kind,subject_value,holder_session,taken_at FROM board_claim
       WHERE project=? AND closed_at IS NULL AND lapses_at>? ORDER BY taken_at,record_id`,
    )
    .all(project, new Date().toISOString())
  return tasks.map<ChildTaskFact>((task) => ({
    key: task.key,
    parentKey: task.parent_key,
    number: Number(/(\d+)$/.exec(task.key)?.[1] ?? Number.MAX_SAFE_INTEGER),
    statusCategory: task.status_category,
    cursorEverComposed: composed.has(task.key),
    liveTaskClaimSession:
      claims.find((claim) => claim.subject_kind === 'task' && claim.subject_value === task.key)
        ?.holder_session ?? null,
    liveQueuedClaimSession:
      claims.find(
        (claim) => claim.subject_kind === 'queued-task' && claim.subject_value === task.key,
      )?.holder_session ?? null,
    queuedAt:
      claims.find(
        (claim) => claim.subject_kind === 'queued-task' && claim.subject_value === task.key,
      )?.taken_at ?? null,
  }))
}

export async function sessionEpicWork(session: string, database: Database = db()) {
  const sessionStages = await taskFlowReadStore(database).listOpenStages({ sessionId: session })
  const claimProjects = database
    .query<{ project: string }, [string]>(
      'SELECT DISTINCT project FROM board_claim WHERE holder_session=? AND closed_at IS NULL',
    )
    .all(session)
  const projects = new Set([
    ...claimProjects.map(({ project }) => project),
    ...sessionStages.map(({ project }) => project),
  ])
  const surfaces: Array<{ epic: string; queue: string[]; open: string[]; cursor: number }> = []
  for (const project of projects) {
    const stages = await taskFlowReadStore(database).listStages({
      project,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
    })
    if (!stages.some((stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start'))
      continue
    const tasks = taskReader().list({ project })
    const facts = await taskFacts(database, project, tasks)
    const queuedEpics = new Set(
      facts
        .filter(({ liveQueuedClaimSession }) => liveQueuedClaimSession === session)
        .map(({ key }) => ancestors(key, tasks).at(-1))
        .filter((key): key is string => Boolean(key)),
    )
    const heldKeys = new Set(
      database
        .query<{ subject_value: string }, [string, string, string]>(
          `SELECT subject_value FROM board_claim WHERE project=? AND holder_session=?
           AND subject_kind='task' AND closed_at IS NULL AND lapses_at>?`,
        )
        .all(project, session, new Date().toISOString())
        .map(({ subject_value }) => subject_value),
    )
    const epicCursors = stages.filter(
      (stage) =>
        stage.workflow_slug === 'plan-task' &&
        stage.step_slug === 'start' &&
        (stage.session_id === session || heldKeys.has(stage.workflow_key)),
    )
    for (const epic of epicCursors) queuedEpics.add(epic.workflow_key)
    for (const epic of queuedEpics) {
      const cursor =
        epicCursors.find(({ workflow_key }) => workflow_key === epic) ??
        stages.find(
          (stage) =>
            stage.workflow_slug === 'plan-task' &&
            stage.step_slug === 'start' &&
            stage.workflow_key === epic,
        )
      if (!cursor) continue
      const state = childQueueState(epic, session, facts)
      surfaces.push({
        epic,
        queue: state.queue.map(({ key }) => key),
        open: state.open.map(({ key }) => key),
        cursor: cursor.id,
      })
    }
  }
  return surfaces
}
