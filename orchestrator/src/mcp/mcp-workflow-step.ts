// concern: MCP workflow step adapter
/** Registers step fetch with live autonomy resolved for the selected cursor composition. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { HubTaskReader } from '../workflow/workflow-task-reference.ts'
import { parseAutonomy } from '../workflow/autonomy.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
} from '../workflow/workflow-compose-branch.ts'
import {
  getWorkflowStepWithCursor,
  resolveLinkedWorkflowCursorMode,
} from '../workflow/workflow-cursor.ts'
import { resolveWorkflowLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
import {
  mcpWorkflowCursorContext,
  resolveWorkflowCursorContext,
} from '../workflow/workflow-cursor-selection.ts'
import { renderWorkflowStep } from '../workflow/workflow-render.ts'
import { resolveWorkflowStepReference } from '../workflow/workflow-step-reference.ts'
import { getWorkflowStep, workflowModeStepLists } from '../workflow/workflows.ts'

const inputSchema = z.object({
  slug: z.string().trim().min(1),
  project: z.string().trim().min(1),
  step: z.string().trim().min(1),
  mode: z.string().trim().min(1).optional(),
  args: z.record(z.string(), z.string()).optional(),
  autonomy: z.string().optional(),
  cursor: z.number().int().positive().optional(),
})

async function workflowStep(
  input: z.infer<typeof inputSchema>,
  commitCount: CommitCountPort,
  hubTaskReader?: HubTaskReader,
) {
  const { slug, project, step, mode, args, autonomy, cursor } = input
  const context = await resolveWorkflowCursorContext(
    project,
    args ?? {},
    mcpWorkflowCursorContext(),
    hubTaskReader,
  )
  const effectiveMode = cursor
    ? resolveLinkedWorkflowCursorMode(
        slug,
        project,
        mode,
        args ?? {},
        context,
        'get_workflow_step',
        'pass the mode argument',
        undefined,
        cursor,
      )
    : mode
  const stepSlug = effectiveMode
    ? step
    : resolveWorkflowStepReference(step, workflowModeStepLists(slug, project))
  const session = parseAutonomy(autonomy, 'session')
  const live = await resolveWorkflowLiveAutonomy({
    slug,
    project,
    mode: effectiveMode,
    args: args ?? {},
    context,
    cursor,
    session,
    step: effectiveMode ? undefined : stepSlug,
  })
  const result = effectiveMode
    ? getWorkflowStepWithCursor(
        slug,
        project,
        stepSlug,
        args ?? {},
        effectiveMode,
        context,
        undefined,
        live,
        cursor,
        commitCount,
      )
    : getWorkflowStep(slug, project, stepSlug, args ?? {}, undefined, { mode }, live.resolution)
  return { content: [{ type: 'text' as const, text: renderWorkflowStep(result) }] }
}

export function registerWorkflowStepTool(
  server: McpServer,
  commitCount: CommitCountPort = readCommitsPastLanding,
  hubTaskReader?: HubTaskReader,
): void {
  server.registerTool(
    'get_workflow_step',
    {
      description:
        'Fetch one workflow step body with argument substitutions applied. Step accepts a slug or a 1-based position from compose_workflow. Pass mode so the workflow cursor applies: fetching step 1 opens the workflow, fetching the current step resumes it, and a step ahead of the cursor is refused. Close a step and receive the next one with next_workflow_step.',
      inputSchema,
    },
    (input) => workflowStep(input, commitCount, hubTaskReader),
  )
}
