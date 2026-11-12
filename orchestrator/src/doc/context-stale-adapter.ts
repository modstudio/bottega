// concern: context-stale-adapter
/** Gathers session work and next-action revision facts for stale context policy. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { projectForTaskKey, projects } from '../project/projects.ts'
import {
  type HubTaskReader,
  readHubTasks,
  taskKeyMap,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import { decodeContextItem } from './context-item-codec.ts'
import { sessionWorkEvents } from './context-session-work-adapter.ts'
import { type ContextWorkEvent, staleContextHolders } from './context-stale.ts'
import { unknownTaskPrefixReport } from './context-write-adapter.ts'
import { listDocsStore } from './doc-read-store.ts'
import { taskContextHolder } from './doc-subjects.ts'

type KeyAt = { key: string | null; at: string }

export async function staleContextForSession(
  session: string,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  now: string = new Date().toISOString(),
) {
  const work: ContextWorkEvent[] = []
  const add = ({ key, at }: KeyAt) => {
    if (key?.trim()) work.push({ holder: key, at })
  }
  for (const row of sessionWorkEvents(session, database)) add(row)

  const registered = projects(undefined, database)
  const workHolders = [...new Set(work.map(({ holder }) => holder))]
  const holderProjects = new Map(
    workHolders.flatMap((holder) => {
      const project = projectForTaskKey(holder, registered)
      return project ? [[holder, project.name] as const] : []
    }),
  )
  const projectNames = [...new Set(holderProjects.values())]
  const tasks = taskKeyMap(
    (await Promise.all(projectNames.map((project) => taskReader(project)))).flat(),
  )
  const resolvedTasks = [...holderProjects].flatMap(([holder, project]) => {
    const task = taskReferenceForProjectKey(tasks, project, holder)
    return task ? [{ holder, task }] : []
  })
  const revisions = resolvedTasks.flatMap(({ holder, task }) =>
    listDocsStore({ scope: 'context', subject: taskContextHolder(task.record_id) }, database)
      .filter((doc) => decodeContextItem(doc.subject!, doc.slug, doc.body).kind === 'next-action')
      .map((doc) => ({ holder, at: doc.updated_at })),
  )
  const taskStatuses = resolvedTasks.map(({ holder, task }) => ({
    holder,
    statusCategory: task.status_category ?? null,
  }))
  const resolvedHolders = new Set(resolvedTasks.map(({ holder }) => holder))
  const unresolvedHolders = workHolders.flatMap((holder) => {
    const project = holderProjects.get(holder)
    if (!project) {
      const unresolved = unknownTaskPrefixReport(holder)
      return [
        {
          holder,
          reason: `${unresolved.detail}; ${unresolved.remedy}`,
        },
      ]
    }
    return resolvedHolders.has(holder)
      ? []
      : [
          {
            holder,
            reason: `task could not be resolved in project ${project}; run ${PLATFORM_SLUG} record pull`,
          },
        ]
  })
  return staleContextHolders({ work, revisions, now, taskStatuses, unresolvedHolders })
}
