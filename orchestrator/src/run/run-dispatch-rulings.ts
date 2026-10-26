// concern: run dispatch rulings
/** Resolves and renders the task rulings inherited by a dispatched run. */

import { resolveHubTaskReference } from './run-task-linking.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'
import { renderTaskRulings } from './task-rulings.ts'

export async function runDispatchRulingsSection(input: {
  resume: boolean
  project: string | null
  key: string | null
}): Promise<string> {
  const task = input.key && input.project ? await resolveHubTaskReference(input.project, input.key) : null
  return renderTaskRulings(
    taskRulingsForDispatch({
      resume: input.resume,
      project: input.project,
      launchKey: input.key,
      taskRecordId: task?.record_id ?? null,
    }),
  )
}
