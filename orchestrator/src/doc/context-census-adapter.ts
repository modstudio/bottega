// concern: context-census-adapter
/** Gathers machine sessions, work, task mirrors, and context items on one store handle. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { claimsOfSession } from '../board/board-claim-service.ts'
import { isOperatorSession } from '../caller-classification.ts'
import { db } from '../database/db.ts'
import { projectForTaskKey, projects } from '../project/projects.ts'
import {
  type HubTaskKeyMap,
  type HubTaskPuller,
  type HubTaskReader,
  type HubTaskReference,
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
  inCensusWindow,
  selectCensusProject,
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
    .filter(({ session }) => !isOperatorSession(session))
}

async function censusWork(
  sessions: readonly ContextCensusSession[],
  registered: ReturnType<typeof projects>,
  database: Database,
): Promise<ContextCensusWork[]> {
  const work: ContextCensusWork[] = []
  for (const { session } of sessions) {
    const events = await sessionWorkEvents(session, database)
    for (const claim of claimsOfSession(session, database)) {
      if (claim.subject.kind !== 'task') continue
      events.push({ key: claim.subject.value, at: claim.takenAt })
      const laterAt = claim.closedAt ?? claim.renewedAt
      if (laterAt !== claim.takenAt) events.push({ key: claim.subject.value, at: laterAt })
    }
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

function readableTask(task: HubTaskReference, database: Database): ContextCensusTaskFact {
  return {
    key: task.key,
    project: task.project,
    title: task.title ?? null,
    statusCategory: task.status_category ?? null,
    items: taskContextItems(task, database).map(({ kind, source, updatedAt }) => ({
      kind,
      source,
      updatedAt,
    })),
    unreadable: null,
  }
}

async function readCensusTask(
  project: string,
  key: string,
  mirrored: HubTaskKeyMap,
  database: Database,
  taskPuller: HubTaskPuller,
): Promise<ContextCensusTaskFact> {
  let task = taskReferenceForProjectKey(mirrored, project, key)
  if (!task) {
    try {
      task = await taskPuller(project, key)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return unreadableTask(
        key,
        project,
        `could not read task ${key}: ${detail}; retry ${PLATFORM_SLUG} task show ${key} --project ${project} --fresh --json`,
      )
    }
  }
  if (!task || task.project !== project || task.key !== key)
    return unreadableTask(
      key,
      project,
      `task ${key} is missing from project ${project}; retry ${PLATFORM_SLUG} task show ${key} --project ${project} --fresh --json`,
    )
  return readableTask(task, database)
}

async function readProjectCensusTasks(
  project: string,
  events: readonly ContextCensusWork[],
  database: Database,
  taskReader: HubTaskReader,
  taskPuller: HubTaskPuller,
): Promise<ContextCensusTaskFact[]> {
  let mirrored: HubTaskKeyMap
  try {
    mirrored = taskKeyMap(await taskReader(project))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const remedy = `could not read project ${project}: ${detail}; retry ${PLATFORM_SLUG} task list --project ${project} --json`
    return events.map(({ key }) => unreadableTask(key, project, remedy))
  }
  return Promise.all(
    events.map(({ key }) => readCensusTask(project, key, mirrored, database, taskPuller)),
  )
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
        .filter(({ at }) => inCensusWindow(at, since))
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
  for (const [project, events] of byProject)
    tasks.push(...(await readProjectCensusTasks(project, events, database, taskReader, taskPuller)))
  return tasks
}

/** Refuse a project filter that does not name a registered project. */
export function assertCensusProjectRegistered(
  project: string | undefined,
  registered: readonly { name: string }[],
): void {
  if (project && !registered.some(({ name }) => name === project))
    throw new Error(`unknown project ${project}; run ${PLATFORM_SLUG} project list --json`)
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
  assertCensusProjectRegistered(input.project, registered)
  const sessions = censusSessions(database)
  const work = await censusWork(sessions, registered, database)
  const report = contextCensus({
    since,
    sessions,
    work,
    tasks: await censusTasks(work, since, database, taskReader, taskPuller),
  })
  if (!input.project) return report
  return selectCensusProject(report, input.project)
}
