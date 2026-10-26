// concern: run dispatch rulings
/** Resolves and renders the task rulings inherited by a dispatched run. */

import { resolveHubTaskReference } from './run-task-linking.ts'
import { renderTaskRulings } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

export async function runDispatchRulingsSection(input: {
  resume: boolean
  project: string | null
  key: string | null
}): Promise<{ section: string; questionIds: string[] }> {
  const task =
    input.key && input.project ? await resolveHubTaskReference(input.project, input.key) : null
  const rulings = taskRulingsForDispatch({
    resume: input.resume,
    project: input.project,
    launchKey: input.key,
    taskRecordId: task?.record_id ?? null,
  })
  return {
    section: renderTaskRulings(rulings),
    questionIds: rulings.rulings.map((ruling) => ruling.questionRecordId),
  }
}
