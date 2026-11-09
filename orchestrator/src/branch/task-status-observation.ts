// concern: branch lifecycle evidence
/** Reads one task's status through the task concern's existing CLI owner. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { TASK_STATUSES } from '../../../shared/trackers.ts'
import {
  type HubTaskReader,
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
  const result = startBoundedSync(
    [...bottegaEntryArgv(PLATFORM_SLUG), 'task', 'show', key, '--project', project, '--json'],
    { budget: 'self-cli', env: process.env },
  )
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`
    return {
      raw: null,
      category: null,
      lastSeen: null,
      verified: false,
      detail: `unverified (${detail})`,
    }
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      task?: { status?: unknown; status_category?: unknown; last_seen?: unknown }
    }
    const raw = typeof parsed.task?.status === 'string' ? parsed.task.status : null
    const lastSeen = typeof parsed.task?.last_seen === 'string' ? parsed.task.last_seen : null
    return taskStatusObservation(raw, lastSeen, parsed.task?.status_category)
  } catch {
    return {
      raw: null,
      category: null,
      lastSeen: null,
      verified: false,
      detail: 'unverified (invalid task response)',
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
              observation: unverifiedObservation(
                'task was not found uniquely in project task list',
              ),
            }
          return {
            project,
            taskKey,
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
            observation: unverifiedObservation(detail),
          }),
        )
      }
    }),
  )
  return observations.flat()
}
