// concern: workflow cursor command target
/** Resolves positional command identity from an optional already-persisted cursor. */

import type { Database } from 'bun:sqlite'
import { flagValue } from '../cli/args.ts'
import { db } from '../database/db.ts'
import {
  type SelectableCursorRow,
  selectWorkflowCursorByHandle,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'

export function cursorCommandTarget(
  argv: string[],
  cursor: number | undefined,
  context: WorkflowCursorContext,
  caller: string,
  hasStep = false,
  database: Database = db(),
): {
  project: string
  workflow: string
  step?: string
  selectedRow?: SelectableCursorRow
} {
  const project = flagValue(argv, 'project')
  const tail = argv.slice(2)
  const flagIndex = tail.findIndex((value) => value.startsWith('--'))
  const positionals = flagIndex < 0 ? tail : tail.slice(0, flagIndex)
  const [suppliedWorkflow, suppliedStep] = hasStep
    ? positionals.length > 1
      ? positionals
      : [undefined, positionals[0]]
    : [positionals[0], undefined]
  let step = suppliedStep
  if (cursor !== undefined) {
    const row = selectWorkflowCursorByHandle(
      { project, workflow: suppliedWorkflow },
      cursor,
      context.session,
      database,
    )
    if (hasStep && (!suppliedStep || (!suppliedWorkflow && suppliedStep === row.workflow_slug)))
      step = row.step_slug
    return { project: row.project, workflow: row.workflow_slug, step, selectedRow: row }
  }
  if (!project) throw new Error('--project is required without --cursor')
  if (!suppliedWorkflow) throw new Error('workflow slug is required without --cursor')
  if (hasStep && !step) throw new Error(`${caller} requires a step slug or position`)
  return { project, workflow: suppliedWorkflow, step }
}
