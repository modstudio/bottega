// concern: session close-out obligations
/** Reads persisted landing and task facts, then delegates close-out obligation decisions. */

import type { Database } from 'bun:sqlite'
import { readBranchLandingTaskRows } from '../branch/branch-landing-records.ts'
import { observeLandedTasks } from '../branch/task-status-observation.ts'
import { taskContextItems } from '../doc/context-service.ts'
import { pendingForSession } from '../evidence/evidence-query.ts'
import { projects } from '../project/projects.ts'
import {
  type HubTaskReader,
  readHubTasks,
  resolveHubTaskReference,
} from '../workflow/workflow-task-reference.ts'
import type { SessionOwnedRun } from './session-close-out-decision.ts'
import {
  landedTaskIdentities,
  OPEN_AFTER_LANDING_CONTEXT_ID,
  sessionCloseOutObligations,
} from './session-close-out-obligations.ts'
import type { SessionProcessLine } from './session-close-out-report.ts'

export async function sessionCloseOutObligationItems(
  database: Database,
  session: string,
  ownedRuns: readonly SessionOwnedRun[],
  taskReader: HubTaskReader = readHubTasks,
): Promise<SessionProcessLine[]> {
  const taskReads = new Map<string, ReturnType<HubTaskReader>>()
  const cachedTaskReader: HubTaskReader = (project) => {
    const existing = taskReads.get(project)
    if (existing) return existing
    const reading = taskReader(project)
    taskReads.set(project, reading)
    return reading
  }
  const ownedRunRecordIds = ownedRuns.map((run) => run.recordId)
  const identities = landedTaskIdentities({
    session,
    ownedRunRecordIds: new Set(ownedRunRecordIds),
    rows: readBranchLandingTaskRows(database),
    keyPrefixesByProject: new Map(
      projects(undefined, database).map((project) => [
        project.name,
        project.settings.keyPrefixes ?? [],
      ]),
    ),
  })
  const landedTasks = await observeLandedTasks(identities, cachedTaskReader)
  const landedWithContext = await Promise.all(
    landedTasks.map(async (task) => {
      const contextTask = await resolveHubTaskReference(
        task.project,
        task.taskKey,
        cachedTaskReader,
      )
      return { ...task, contextTask }
    }),
  )
  return sessionCloseOutObligations({
    pendingScores: pendingForSession(session, database),
    acknowledgementDate: new Date().toISOString().slice(0, 'YYYY-MM-DD'.length),
    landedTasks: landedWithContext.map((task) => ({
      ...task,
      openAfterLandingAcknowledged:
        task.contextTask?.record_id !== undefined &&
        taskContextItems(task.contextTask, database).some(
          (item) => item.id === OPEN_AFTER_LANDING_CONTEXT_ID && item.kind === 'ruling',
        ),
    })),
  })
}
