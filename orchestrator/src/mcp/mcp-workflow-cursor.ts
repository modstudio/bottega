// concern: MCP workflow cursor resolution
/** Owns the shared selected-row, task-context and mode resolution for MCP workflow operations. */

import {
  resolveMcpSelectedCursorContext,
  type SelectableCursorRow,
  type WorkflowCursorContext,
} from '../workflow/workflow-cursor-selection.ts'
import { resolveLinkedWorkflowCursorMode } from '../workflow/workflow-task-linking.ts'
import type { HubTaskReader } from '../workflow/workflow-task-reference.ts'

export async function resolveMcpLinkedWorkflowCursor(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  cursor: number | undefined,
  caller: string,
  remedy: string,
  reader?: HubTaskReader,
): Promise<{
  context: WorkflowCursorContext
  selectedRow?: SelectableCursorRow
  effectiveMode: string
}> {
  const { context, selectedRow } = await resolveMcpSelectedCursorContext(
    project,
    slug,
    requested,
    args,
    cursor,
    reader,
  )
  return {
    context,
    selectedRow,
    effectiveMode: resolveLinkedWorkflowCursorMode(
      slug,
      project,
      requested,
      args,
      context,
      caller,
      remedy,
      undefined,
      selectedRow,
    ),
  }
}
