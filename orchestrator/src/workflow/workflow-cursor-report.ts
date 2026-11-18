// concern: workflow cursor reporting
/** Enriches the existing cursor listing with task closure and bound-run health. */

import { flagValue } from '../cli/args.ts'
import { taskFlowState } from './task-flow-decision.ts'
import { TASK_FLOW_OPEN_STAGE_STATES } from './task-flow-store-types.ts'
import type { WorkflowPrint } from './workflow-commands.ts'
import { renderWorkflowCursorLine } from './workflow-cursor-format.ts'
import { listWorkflowCursors } from './workflow-cursor-list.ts'
import {
  type HubTaskReader,
  readHubTasks,
  taskKeyMap,
  taskReadRefusal,
  taskReferenceForProjectKey,
} from './workflow-task-reference.ts'

/** Names the closed task an open cursor outlived; a finished or abandoned cursor outlived nothing. */
export function closedTaskAnnotation(
  cursorState: string,
  taskStatusCategory: string | null,
): string | null {
  if (!TASK_FLOW_OPEN_STAGE_STATES.some((state) => state === cursorState)) return null
  const closed = taskFlowState(taskStatusCategory)
  return closed === 'done' || closed === 'dropped' ? `CLOSED TASK ${closed}` : null
}

export async function cursorsCommand(
  argv: string[],
  print: WorkflowPrint,
  options: { hubTaskReader?: HubTaskReader } = {},
): Promise<void> {
  const rows = await listWorkflowCursors({
    session: flagValue(argv, 'session'),
    project: flagValue(argv, 'project'),
    all: argv.includes('--all'),
  })
  if (!rows.length) return
  if (argv.includes('--json')) {
    print(rows)
    return
  }
  const reader = options.hubTaskReader ?? readHubTasks
  const projects = [...new Set(rows.filter((row) => row.workflow_key).map((row) => row.project))]
  const warnings: string[] = []
  const taskRows = (
    await Promise.all(
      projects.map(async (project) => {
        try {
          return await reader(project)
        } catch (error) {
          warnings.push(
            taskReadRefusal(project, error instanceof Error ? error.message : String(error))
              .message,
          )
          return []
        }
      }),
    )
  ).flat()
  const tasks = taskKeyMap(taskRows)
  const measured = rows.map((row) => ({
    ...row,
    task_status_category: row.workflow_key
      ? (taskReferenceForProjectKey(tasks, row.project, row.workflow_key)?.status_category ?? null)
      : null,
  }))
  print(
    measured,
    measured
      .map((row) => {
        const line = renderWorkflowCursorLine(row)
        const annotation = closedTaskAnnotation(row.state, row.task_status_category)
        return annotation ? `${line}  ${annotation}` : line
      })
      .concat(warnings.map((warning) => `warning: ${warning}`))
      .join('\n'),
  )
}
