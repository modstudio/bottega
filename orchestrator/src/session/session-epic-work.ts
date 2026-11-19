// concern: session epic work
/** Gathers the epic queue surface for one live session without changing claims. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { TASK_FLOW_OPEN_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { taskReader } from '../workflow/task-read-port.ts'
import { gatherChildTaskFacts, liveChildClaims } from '../workflow/workflow-child-facts.ts'
import { childQueueState } from '../workflow/workflow-child-queue.ts'
import { descendantTaskKeys } from '../workflow/workflow-task-tree.ts'

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
    const facts = await gatherChildTaskFacts(database, project, tasks)
    const claims = liveChildClaims(database, project).filter(
      ({ holder_session }) => holder_session === session,
    )
    const epicCursors = stages.filter(
      (stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start',
    )
    for (const cursor of epicCursors) {
      const descendants = descendantTaskKeys(cursor.workflow_key, facts)
      if (
        !claims.some(
          (claim) =>
            (claim.subject_kind === 'task' || claim.subject_kind === 'queued-task') &&
            (claim.subject_value === cursor.workflow_key || descendants.has(claim.subject_value)),
        )
      )
        continue
      const state = childQueueState(cursor.workflow_key, session, facts)
      surfaces.push({
        epic: cursor.workflow_key,
        queue: state.queue.map(({ key }) => key),
        open: state.open.map(({ key }) => key),
        cursor: cursor.id,
      })
    }
  }
  return surfaces
}
