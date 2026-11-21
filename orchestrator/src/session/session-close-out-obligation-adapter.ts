// concern: session close-out obligations
/** Reads persisted landing and task facts, then delegates close-out obligation decisions. */

import type { Database } from 'bun:sqlite'
import { readBranchLandingTaskRows } from '../branch/branch-landing-records.ts'
import { observeLandedTasks } from '../branch/task-status-observation.ts'
import { listContextItems } from '../doc/context-item-store.ts'
import { taskContextHolder } from '../doc/doc-subjects.ts'
import { pendingForSession } from '../evidence/evidence-query.ts'
import { projects } from '../project/projects.ts'
import { type ProjectTaskListReader, readProjectTaskList } from '../workflow/project-task-list.ts'
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
  taskReader: ProjectTaskListReader = readProjectTaskList,
): Promise<SessionProcessLine[]> {
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
  const landedTasks = await observeLandedTasks(identities, taskReader)
  const taskHolders = landedTasks.flatMap((observation) =>
    observation.task ? [taskContextHolder(observation.task.record_id)] : [],
  )
  const contextByTask = Map.groupBy(await listContextItems(taskHolders, database), (item) =>
    item.holder.slice('task:'.length),
  )
  return sessionCloseOutObligations({
    pendingScores: pendingForSession(session, database),
    acknowledgementDate: new Date().toISOString().slice(0, 'YYYY-MM-DD'.length),
    landedTasks: landedTasks.map((observation) => ({
      ...observation,
      openAfterLandingAcknowledged:
        observation.task !== null &&
        (contextByTask.get(observation.task.record_id) ?? []).some(
          (item) => item.id === OPEN_AFTER_LANDING_CONTEXT_ID && item.kind === 'ruling',
        ),
    })),
  })
}
