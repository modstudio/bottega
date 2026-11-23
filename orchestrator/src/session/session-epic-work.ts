// concern: session epic work
/** Gathers the epic queue surface for one live session without changing claims. */

import type { Database } from 'bun:sqlite'
import { boardLiveClaimProjectsForSession } from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import { TASK_FLOW_OPEN_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { readLiveProjectTasks, readProjectTaskList } from '../workflow/project-task-list.ts'
import { lookupProjectTasks } from '../workflow/project-task-lookup.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { gatherChildTaskFacts, liveChildClaims } from '../workflow/workflow-child-facts.ts'
import {
  childQueueState,
  sessionWorksUnderEpic,
  taskKeysWithChildren,
} from '../workflow/workflow-child-queue.ts'
import { descendantTaskKeys } from '../workflow/workflow-task-tree.ts'

export async function sessionEpicWork(
  session: string,
  sessionStages: readonly { project: string }[],
  database: Database = db(),
) {
  const claimProjects = await boardLiveClaimProjectsForSession(session, Date.now(), database)
  const projects = new Set([...claimProjects, ...sessionStages.map(({ project }) => project)])
  const surfaces: Array<{ epic: string; queue: string[]; open: string[]; cursor: number }> = []
  for (const project of projects) {
    const stages = await taskFlowReadStore(database).listStages({
      project,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
    })
    if (!stages.some((stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start'))
      continue
    const listedTasks = await readLiveProjectTasks(readProjectTaskList, project)
    const listedKeys = [...new Set(listedTasks.map((task) => task.key))]
    const tasks = await lookupProjectTasks(project, listedKeys)
    const claims = (await liveChildClaims(database, project)).filter(
      ({ holderSession }) => holderSession === session,
    )
    const facts = await gatherChildTaskFacts(database, project, tasks, claims)
    const epicCursors = stages.filter(
      (stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start',
    )
    const hasChildren = taskKeysWithChildren(facts)
    for (const cursor of epicCursors) {
      if (!hasChildren.has(cursor.workflow_key)) continue
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
