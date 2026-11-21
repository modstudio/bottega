// concern: session epic work
/** Gathers the epic queue surface for one live session without changing claims. */

import type { Database } from 'bun:sqlite'
import { boardLiveClaimProjectsForSession } from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import { TASK_FLOW_OPEN_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { readProjectTaskList } from '../workflow/project-task-list.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { gatherChildTaskFacts, liveChildClaims } from '../workflow/workflow-child-facts.ts'
import { childQueueState, sessionWorksUnderEpic } from '../workflow/workflow-child-queue.ts'
import { descendantTaskKeys } from '../workflow/workflow-task-tree.ts'

const SESSION_STOP_TASK_STATUSES = ['open', 'active', 'review'] as const

export async function sessionEpicWork(session: string, database: Database = db()) {
  const sessionStages = await taskFlowReadStore(database).listOpenStages({ sessionId: session })
  const claimProjects = boardLiveClaimProjectsForSession(session, Date.now(), database)
  const projects = new Set([...claimProjects, ...sessionStages.map(({ project }) => project)])
  const surfaces: Array<{ epic: string; queue: string[]; open: string[]; cursor: number }> = []
  for (const project of projects) {
    const stages = await taskFlowReadStore(database).listStages({
      project,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
    })
    if (!stages.some((stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start'))
      continue
    const tasks = (
      await Promise.all(
        SESSION_STOP_TASK_STATUSES.map((status) => readProjectTaskList(project, { status })),
      )
    ).flat()
    const facts = await gatherChildTaskFacts(database, project, tasks)
    const claims = liveChildClaims(database, project).filter(
      ({ holder_session }) => holder_session === session,
    )
    const epicCursors = stages.filter(
      (stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start',
    )
    for (const cursor of epicCursors) {
      const descendants = descendantTaskKeys(cursor.workflow_key, facts)
      if (!sessionWorksUnderEpic(claims, session, cursor.workflow_key, descendants)) continue
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
