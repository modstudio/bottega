// concern: context-stale-adapter
/** Gathers session work and next-action revision facts for stale context policy. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectForTaskKey, projects } from '../project/projects.ts'
import { questionTaskHolderSql } from '../run/question-open.ts'
import { type CursorTrailEntry, isClosedStep } from '../workflow/workflow-cursor-trail.ts'
import {
  type HubTaskReader,
  readHubTasks,
  taskKeyMap,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import { decodeContextItem } from './context-item-codec.ts'
import { type ContextWorkEvent, staleContextHolders } from './context-stale.ts'
import { contextTaskHolderKey } from './context-write-adapter.ts'
import { listDocsStore } from './doc-read-store.ts'

type KeyAt = { key: string | null; at: string }
type CursorWork = { key: string; closed: string }

export async function staleContextForSession(
  session: string,
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
) {
  const work: ContextWorkEvent[] = []
  const add = ({ key, at }: KeyAt) => {
    if (key?.trim()) work.push({ holder: key, at })
  }
  for (const row of database
    .query<KeyAt, [string]>(
      'SELECT launch_key key,started_at at FROM run WHERE session_id=? AND launch_key IS NOT NULL',
    )
    .all(session))
    add(row)
  for (const row of database
    .query<CursorWork, [string]>(
      "SELECT workflow_key key,closed FROM workflow_cursor WHERE session_id=? AND workflow_key<>''",
    )
    .all(session)) {
    for (const entry of JSON.parse(row.closed) as CursorTrailEntry[])
      if (isClosedStep(entry)) add({ key: row.key, at: entry.at })
  }
  for (const row of database
    .query<KeyAt, [string, string]>(
      `SELECT ${questionTaskHolderSql('q', 'r')} key,q.answered_at at
       FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
       WHERE q.answered_by IN (?,?) AND q.answered_at IS NOT NULL`,
    )
    .all(session, `operator via ${session}`))
    add(row)

  const revisions = listDocsStore({ scope: 'context' }, database).flatMap((doc) => {
    const holder = contextTaskHolderKey(doc.subject)
    if (!holder || decodeContextItem(doc.subject!, doc.slug, doc.body).kind !== 'next-action')
      return []
    return [{ holder, at: doc.updated_at }]
  })
  const registered = projects(undefined, database)
  const holderProjects = new Map(
    [...new Set(work.map(({ holder }) => holder))].flatMap((holder) => {
      const project = projectForTaskKey(holder, registered)
      return project ? [[holder, project.name] as const] : []
    }),
  )
  const projectNames = [...new Set(holderProjects.values())]
  const tasks = taskKeyMap(
    (await Promise.all(projectNames.map((project) => taskReader(project)))).flat(),
  )
  const taskStatuses = [...holderProjects].flatMap(([holder, project]) => {
    const task = taskReferenceForProjectKey(tasks, project, holder)
    return task ? [{ holder, statusCategory: task.status_category ?? null }] : []
  })
  return staleContextHolders(work, revisions, taskStatuses)
}
