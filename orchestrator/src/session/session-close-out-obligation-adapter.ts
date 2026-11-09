// concern: session close-out obligations
/** Reads persisted landing and task facts, then delegates close-out obligation decisions. */

import type { Database } from 'bun:sqlite'
import { type StatusCategory, TASK_STATUSES } from '../../../shared/trackers.ts'
import { pendingForSession } from '../evidence/evidence-query.ts'
import {
  readHubTasks,
  taskKeyMap,
  taskReadRefusal,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'
import type { SessionOwnedRun } from './session-close-out-decision.ts'
import {
  type LandedTaskObservation,
  type LandedTaskRow,
  landedTaskIdentities,
  sessionCloseOutObligations,
} from './session-close-out-obligations.ts'
import type { SessionProcessLine } from './session-close-out-report.ts'

function landedTaskRows(database: Database): LandedTaskRow[] {
  return database
    .query<LandedTaskRow, []>(
      // Materialize because run has no index on (project_record_id, minted_branch).
      `WITH minted AS MATERIALIZED (
         SELECT record_id,project_record_id,minted_branch,launch_key
           FROM run
          WHERE minted_branch IS NOT NULL
       )
       SELECT blr.project,blr.branch,blr.recording_session recordingSession,
              m.record_id runRecordId,m.launch_key taskKey
         FROM branch_landing_record blr
         LEFT JOIN minted m
           ON m.project_record_id=blr.project_record_id AND m.minted_branch=blr.branch
        ORDER BY blr.project,blr.branch,m.record_id`,
    )
    .all()
}

function verifiedObservation(category: StatusCategory): LandedTaskObservation['observation'] {
  return { category, verified: true, detail: category }
}

function unverifiedObservation(detail: string): LandedTaskObservation['observation'] {
  return { category: null, verified: false, detail: `unverified (${detail})` }
}

async function observeLandedTasks(
  identities: readonly { project: string; taskKey: string }[],
): Promise<LandedTaskObservation[]> {
  const byProject = new Map<string, string[]>()
  for (const identity of identities)
    byProject.set(identity.project, [...(byProject.get(identity.project) ?? []), identity.taskKey])

  const observations = await Promise.all(
    [...byProject].map(async ([project, keys]) => {
      try {
        const tasks = taskKeyMap(await readHubTasks(project))
        return keys.map((taskKey): LandedTaskObservation => {
          const task = taskReferenceForProjectKey(tasks, project, taskKey)
          if (!task)
            return {
              project,
              taskKey,
              observation: unverifiedObservation(
                'task was not found uniquely in project task list',
              ),
            }
          const category = TASK_STATUSES.find((candidate) => candidate === task.status_category)
          return {
            project,
            taskKey,
            observation: category
              ? verifiedObservation(category)
              : unverifiedObservation(
                  task.status_category == null
                    ? 'missing status category'
                    : `unknown status category ${JSON.stringify(task.status_category)}`,
                ),
          }
        })
      } catch (cause) {
        const detail = taskReadRefusal(
          project,
          cause instanceof Error ? cause.message : String(cause),
        ).message
        return keys.map(
          (taskKey): LandedTaskObservation => ({
            project,
            taskKey,
            observation: unverifiedObservation(detail),
          }),
        )
      }
    }),
  )
  return observations.flat()
}

export async function sessionCloseOutObligationItems(
  database: Database,
  session: string,
  ownedRuns: readonly SessionOwnedRun[],
): Promise<SessionProcessLine[]> {
  const ownedRunRecordIds = ownedRuns.map((run) => run.recordId)
  const identities = landedTaskIdentities({
    session,
    ownedRunRecordIds: new Set(ownedRunRecordIds),
    rows: landedTaskRows(database),
  })
  return sessionCloseOutObligations({
    pendingScores: pendingForSession(session, database),
    landedTasks: await observeLandedTasks(identities),
  })
}
