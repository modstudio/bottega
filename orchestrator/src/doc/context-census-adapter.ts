// concern: context-census-adapter
/** Gathers machine sessions, work, task mirrors, and context items on one store handle. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { projectForTaskKey, projects } from '../project/projects.ts'
import {
  type HubTaskKeyMap,
  type HubTaskPuller,
  type HubTaskReader,
  pullHubTask,
  readHubTasks,
  taskKeyMap,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import {
  CONTEXT_CENSUS_DEFAULT_WINDOW_MS,
  type ContextCensusSession,
  type ContextCensusTaskFact,
  type ContextCensusWork,
  contextCensus,
} from './context-census.ts'
import { taskContextItems } from './context-service.ts'
import { sessionWorkEvents } from './context-session-work-adapter.ts'
import { unknownTaskPrefixReport } from './context-write-adapter.ts'

type PresenceSessionRow = {
  session: string
  lastSeen: string
  project: string | null
}

function censusSessions(database: Database): ContextCensusSession[] {
  return database
    .query<PresenceSessionRow, []>(
      `SELECT sessions.session,MAX(sessions.lastSeen) lastSeen,MAX(sessions.project) project
         FROM (
           SELECT session_id session,last_seen lastSeen,project FROM presence
           UNION ALL
           SELECT session_id session,last_seen lastSeen,NULL project FROM session_seen
         ) sessions
        WHERE sessions.session NOT IN
          (SELECT vendor_session FROM run WHERE vendor_session IS NOT NULL)
        GROUP BY sessions.session`,
    )
    .all()
}

async function censusWork(
  sessions: readonly ContextCensusSession[],
  registered: ReturnType<typeof projects>,
  database: Database,
): Promise<ContextCensusWork[]> {
  const work: ContextCensusWork[] = []
  for (const { session } of sessions) {
    const events = await sessionWorkEvents(session, database)
    events.push(
      ...database
        .query<{ key: string; at: string }, [string]>(
          `SELECT subject_value key,taken_at at FROM board_claim
            WHERE holder_session=? AND subject_kind='task'`,
        )
        .all(session),
    )
    for (const event of events) {
      if (!event.key?.trim()) continue
      work.push({
        session,
        key: event.key,
        at: event.at,
        project: projectForTaskKey(event.key, registered)?.name ?? null,
      })
    }
  }
  return work
}

function unreadableTask(
  key: string,
  project: string | null,
  remedy: string,
): ContextCensusTaskFact {
  return { key, project, title: null, statusCategory: null, items: [], unreadable: remedy }
}

async function censusTasks(
  work: readonly ContextCensusWork[],
  since: string,
  database: Database,
  taskReader: HubTaskReader,
  taskPuller: HubTaskPuller,
): Promise<ContextCensusTaskFact[]> {
  const identities = [
    ...new Map(
      work
        .filter(({ at }) => at >= since)
        .map((event) => [`${event.project ?? ''}\0${event.key}`, event]),
    ).values(),
  ]
  const tasks: ContextCensusTaskFact[] = identities
    .filter(({ project }) => project === null)
    .map(({ key }) => {
      const report = unknownTaskPrefixReport(key)
      return unreadableTask(key, null, `${report.detail}; ${report.remedy}`)
    })
  const byProject = Map.groupBy(
    identities.filter((event): event is ContextCensusWork & { project: string } =>
      Boolean(event.project),
    ),
    ({ project }) => project,
  )
  for (const [project, events] of byProject) {
    let mirrored: HubTaskKeyMap
    try {
      mirrored = taskKeyMap(await taskReader(project))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const remedy = `could not read project ${project}: ${detail}; retry ${PLATFORM_SLUG} task list --project ${project} --json`
      tasks.push(...events.map(({ key }) => unreadableTask(key, project, remedy)))
      continue
    }
    for (const { key } of events) {
      let task = taskReferenceForProjectKey(mirrored, project, key)
      if (!task) {
        try {
          task = await taskPuller(project, key)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          tasks.push(
            unreadableTask(
              key,
              project,
              `could not read task ${key}: ${detail}; retry ${PLATFORM_SLUG} task show ${key} --project ${project} --fresh --json`,
            ),
          )
          continue
        }
      }
      if (!task || task.project !== project || task.key !== key) {
        tasks.push(
          unreadableTask(
            key,
            project,
            `task ${key} is missing from project ${project}; retry ${PLATFORM_SLUG} task show ${key} --project ${project} --fresh --json`,
          ),
        )
        continue
      }
      tasks.push({
        key,
        project,
        title: task.title ?? null,
        statusCategory: task.status_category ?? null,
        items: taskContextItems(task, database).map(({ kind, source, updatedAt }) => ({
          kind,
          source,
          updatedAt,
        })),
        unreadable: null,
      })
    }
  }
  return tasks
}

export async function contextCensusReport(
  input: { since?: string; project?: string; now?: string } = {},
  database: Database = db(),
  taskReader: HubTaskReader = readHubTasks,
  taskPuller: HubTaskPuller = pullHubTask,
) {
  const now = input.now ?? new Date().toISOString()
  const since =
    input.since ?? new Date(Date.parse(now) - CONTEXT_CENSUS_DEFAULT_WINDOW_MS).toISOString()
  if (!Number.isFinite(Date.parse(since))) throw new Error('--since must be an ISO date')
  const registered = projects(undefined, database)
  const sessions = censusSessions(database)
  const work = await censusWork(sessions, registered, database)
  const report = contextCensus({
    since,
    sessions,
    work,
    tasks: await censusTasks(work, since, database, taskReader, taskPuller),
  })
  if (!input.project) return report
  const selected = report.projects.filter(({ project }) => project === input.project)
  const taskRows = selected.flatMap(({ sessions }) => sessions.flatMap(({ tasks }) => tasks))
  const uncovered = taskRows.filter(({ status }) => status === 'uncovered').map(({ key }) => key)
  const unreadable = taskRows
    .filter(
      (row): row is typeof row & { remedy: string } =>
        row.status === 'unreadable' && row.remedy !== null,
    )
    .map(({ key, remedy }) => ({ task: key, remedy }))
  return {
    ...report,
    projects: selected,
    verdict: { full: uncovered.length === 0 && unreadable.length === 0, uncovered, unreadable },
  }
}
