import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { db } from '../database/db.ts'
import type { CommitCountPort } from '../workflow/workflow-compose-branch.ts'
import { resolveWorkflowLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
import {
  resolveMcpSelectedCursorContext,
  selectWorkflowCursorByHandle,
} from '../workflow/workflow-cursor-selection.ts'
import { handoffWorkflow } from '../workflow/workflow-handoff.ts'
import type { HubTaskReader } from '../workflow/workflow-task-reference.ts'

type HandoffToolPorts = { hubTaskReader?: HubTaskReader; commitCount?: CommitCountPort }

export function registerWorkflowHandoffTool(
  server: McpServer,
  ports: HandoffToolPorts,
  text: (value: unknown) => { content: Array<{ type: 'text'; text: string }> },
): void {
  server.registerTool(
    'handoff_workflow',
    {
      description:
        'Close one keyed workflow cursor and atomically open a named successor for the same key.',
      inputSchema: z.object({
        workflow: z.string().trim().min(1),
        cursor: z.number().int().positive(),
        project: z.string().trim().min(1),
        reason: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
      }),
    },
    async ({ workflow, cursor, project, reason, mode, args = {} }) => {
      const row = await selectWorkflowCursorByHandle({ project }, cursor, undefined, db())
      const { context } = await resolveMcpSelectedCursorContext(
        project,
        row.workflow_slug,
        row.mode_slug,
        { ...args, key: row.workflow_key },
        cursor,
        ports.hubTaskReader,
      )
      const live = await resolveWorkflowLiveAutonomy({
        slug: workflow,
        project,
        mode,
        args,
        context,
      })
      return text(
        await handoffWorkflow({
          row,
          workflow,
          mode,
          args,
          reason,
          context,
          live,
          commitCount: ports.commitCount,
        }),
      )
    },
  )
}
