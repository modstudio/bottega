// concern: MCP workflow repin adapter

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { db } from '../database/db.ts'
import {
  mcpWorkflowCursorContext,
  selectWorkflowCursorByHandle,
} from '../workflow/workflow-cursor-selection.ts'
import { repinWorkflowCursor } from '../workflow/workflow-repin.ts'

export function registerWorkflowRepinTool(
  server: McpServer,
  text: (value: unknown) => { content: Array<{ type: 'text'; text: string }> },
): void {
  server.registerTool(
    'repin_workflow',
    {
      description:
        'Re-point an open cursor to the current production workflow and catalogue versions.',
      inputSchema: z.object({
        cursor: z.number().int().positive(),
        project: z.string().trim().min(1).optional(),
        reason: z.string().trim().min(1),
      }),
    },
    async ({ cursor, project, reason }) => {
      const context = mcpWorkflowCursorContext()
      const row = await selectWorkflowCursorByHandle({ project }, cursor, context.session, db())
      return text(await repinWorkflowCursor({ row, reason, context }))
    },
  )
}
