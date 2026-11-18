// concern: explore graduation handoff
/** Converts an untouched keyless explore into the requested task workflow through handoff. */

import type { Database } from 'bun:sqlite'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import type { CommitCountPort } from './workflow-compose-branch.ts'
import { graduatingExploreCursor } from './workflow-cursor-compose.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'
import { handoffWorkflow } from './workflow-handoff.ts'
import type { TaskCursorClaimPorts } from './workflow-task-claim.ts'
import type { composeWorkflow } from './workflows.ts'

export async function handoffGraduatingExplore(
  composition: ReturnType<typeof composeWorkflow>,
  context: WorkflowCursorContext,
  database: Database,
  live: LiveCursorAutonomy,
  commitCount: CommitCountPort,
  taskClaimPorts?: TaskCursorClaimPorts,
): Promise<
  | (ReturnType<typeof cursorComposition> & {
      cursor: {
        id: number
        n: number
        slug: string
        state: SelectableCursorRow['state']
        opened: true
        previousSession: null
      }
      graduated: { cursor: number; closed: true }
      claimWarning?: string
    })
  | undefined
> {
  const source = await graduatingExploreCursor({
    project: composition.project,
    session: context.session,
    taskBound: Boolean(composition.arguments.key),
    database,
    taskFlowClient: context.taskFlowClient,
  })
  if (!source) return undefined
  const result = await handoffWorkflow({
    row: source,
    workflow: composition.workflow.slug,
    mode: composition.mode!.slug,
    args: composition.arguments,
    reason: `graduated to ${composition.workflow.slug}`,
    context,
    live,
    database,
    commitCount,
    taskClaimPorts,
  })
  const row = await taskFlowReadStore(database, context.taskFlowClient).stageByHandle(
    composition.project,
    result.cursor,
  )
  if (!row) throw new Error(`graduated workflow cursor ${result.cursor} cannot be read; retry`)
  return {
    ...cursorComposition(row, database, live),
    cursor: {
      id: row.id,
      n: row.ordinal + 1,
      slug: row.step_slug,
      state: row.state,
      opened: true,
      previousSession: null,
    },
    ...(result.claimWarning ? { claimWarning: result.claimWarning } : {}),
    graduated: { cursor: source.id, closed: true },
  }
}
