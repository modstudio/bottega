// concern: run dispatch rulings
/** Resolves and renders the task rulings inherited by a dispatched run. */

import { renderTaskRulings } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

export function runDispatchRulingsSection(input: {
  resume: boolean
  project: string | null
  key: string | null
  taskRecordId: string | null
}): { section: string; questionIds: string[] } {
  const rulings = taskRulingsForDispatch({
    resume: input.resume,
    project: input.project,
    launchKey: input.key,
    taskRecordId: input.resume ? null : input.taskRecordId,
  })
  return {
    section: renderTaskRulings(rulings),
    questionIds: rulings.rulings.map((ruling) => ruling.questionRecordId),
  }
}
