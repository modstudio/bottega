// concern: session close-out next-action report
/** Resolves worked task holders and reports their next-action state without blocking close-out. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { taskContextItems } from '../doc/context-service.ts'
import { resolveContextTask } from '../doc/context-write-adapter.ts'
import { missingContextKinds } from '../doc/doc-context-write.ts'
import { projectForTaskKey, projects } from '../project/projects.ts'

export type TaskNextActionOutcome =
  | { key: string; status: 'present' }
  | { key: string; status: 'missing' }
  | { key: string; status: 'unknown-prefix'; detail: string; remedy: string }
  | { key: string; status: 'unreadable'; detail: string; remedy: string }

export async function taskNextActionOutcomes(
  keys: readonly string[],
  database: Database = db(),
): Promise<TaskNextActionOutcome[]> {
  const registered = projects(undefined, database)
  const outcomes: TaskNextActionOutcome[] = []
  for (const key of keys) {
    if (!projectForTaskKey(key, registered)) {
      outcomes.push({
        key,
        status: 'unknown-prefix',
        detail: `no single project declares the task prefix of ${key}`,
        remedy: `declare it in one project's keyPrefixes with ${PLATFORM_SLUG} project set <project> --settings`,
      })
      continue
    }
    try {
      const task = await resolveContextTask(key, database)
      outcomes.push({
        key,
        status: missingContextKinds(taskContextItems(task, database), 'task').includes(
          'next-action',
        )
          ? 'missing'
          : 'present',
      })
    } catch (cause) {
      outcomes.push({
        key,
        status: 'unreadable',
        detail: cause instanceof Error ? cause.message : String(cause),
        remedy: `${PLATFORM_SLUG} record pull`,
      })
    }
  }
  return outcomes
}
