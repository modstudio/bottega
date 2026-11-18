// concern: branch lifecycle evidence
/** Reads one task's status through the installed task reader. */

import { TASK_STATUSES } from '../../../shared/trackers.ts'
import { taskReader } from '../workflow/task-read-port.ts'
import {
  type HubTaskReader,
  type HubTaskReference,
  readHubTasks,
  taskKeyMap,
  taskReadRefusal,
  taskReferenceForProjectKey,
} from '../workflow/workflow-task-reference.ts'

export type TaskStatusObservation = {
  raw: string | null
  category: string | null
  lastSeen: string | null
  verified: boolean
  detail: string
}

export type LandedTaskObservation = {
  project: string
  taskKey: string
  task: HubTaskReference | null
  observation: TaskStatusObservation
}

function unverifiedObservation(
  detail: string,
  raw: string | null = null,
  lastSeen: string | null = null,
): TaskStatusObservation {
  return {
    raw,
    category: null,
    lastSeen,
    verified: false,
    detail: `unverified (${detail})`,
  }
}

function taskStatusObservation(
  raw: string | null,
  lastSeen: string | null,
  candidate: unknown,
): TaskStatusObservation {
  const category = TASK_STATUSES.find((status) => status === candidate) ?? null
  if (category) return { raw, category, lastSeen, verified: true, detail: raw ?? category }
  return unverifiedObservation(
    candidate == null
      ? 'missing status category'
      : `unknown status category ${JSON.stringify(candidate)}`,
    raw,
    lastSeen,
  )
}

export function observeTaskStatus(key: string | null, project: string): TaskStatusObservation {
  if (!key) return { raw: null, category: null, lastSeen: null, verified: false, detail: 'unkeyed' }
  try {
    const parsed = taskReader().show(key, { project })
    const raw = typeof parsed.task.status === 'string' ? parsed.task.status : null
    const lastSeen = typeof parsed.task.last_seen === 'string' ? parsed.task.last_seen : null
    return taskStatusObservation(raw, lastSeen, parsed.task.status_category)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      raw: null,
      category: null,
      lastSeen: null,
      verified: false,
      detail: `unverified (${detail})`,
    }
  }
}

/** Observe landed task statuses with one task-list read per project. */
export async function observeLandedTasks(
  identities: readonly { project: string; taskKey: string }[],
  taskReader: HubTaskReader = readHubTasks,
): Promise<LandedTaskObservation[]> {
  const byProject = Map.groupBy(identities, (identity) => identity.project)
  const observations = await Promise.all(
    [...byProject].map(async ([project, projectIdentities]) => {
      try {
        const tasks = taskKeyMap(await taskReader(project))
        return projectIdentities.map(({ taskKey }): LandedTaskObservation => {
          const task = taskReferenceForProjectKey(tasks, project, taskKey)
          if (!task)
            return {
              project,
              taskKey,
              task: null,
              observation: unverifiedObservation(
                'task was not found uniquely in project task list',
              ),
            }
          return {
            project,
            taskKey,
            task,
            observation: taskStatusObservation(null, null, task.status_category),
          }
        })
      } catch (cause) {
        const detail = taskReadRefusal(
          project,
          cause instanceof Error ? cause.message : String(cause),
        ).message
        return projectIdentities.map(
          ({ taskKey }): LandedTaskObservation => ({
            project,
            taskKey,
            task: null,
            observation: unverifiedObservation(detail),
          }),
        )
      }
    }),
  )
  return observations.flat()
}
