// concern: session close-out next-action report
/** Resolves worked task holders and reports their next-action state without blocking close-out. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { taskContextItems } from '../doc/context-service.ts'
import {
  ContextTaskPrefixError,
  resolveContextTask,
  unknownTaskPrefixReport,
} from '../doc/context-write-adapter.ts'
import { missingContextKinds } from '../doc/doc-context-write.ts'
import { TaskNotFoundError } from '../workflow/workflow-task-reference.ts'

export type TaskNextActionOutcome =
  | { key: string; status: 'present' }
  | { key: string; status: 'missing' }
  | { key: string; status: 'unknown-prefix'; detail: string; remedy: string }
  | { key: string; status: 'absent'; detail: string; remedy: string }
  | { key: string; status: 'unreadable'; detail: string; remedy: string }

export async function taskNextActionOutcomes(
  keys: readonly string[],
  database: Database = db(),
): Promise<TaskNextActionOutcome[]> {
  const outcomes: TaskNextActionOutcome[] = []
  for (const key of keys) {
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
      if (cause instanceof ContextTaskPrefixError) {
        outcomes.push({ key, status: 'unknown-prefix', ...unknownTaskPrefixReport(key) })
        continue
      }
      if (cause instanceof TaskNotFoundError) {
        outcomes.push({ key, status: 'absent', detail: cause.message, remedy: cause.remedy })
        continue
      }
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
