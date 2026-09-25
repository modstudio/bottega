// concern: operator-waiting
/** Registers MCP adapters for operator-ruling mutations. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { relayQuestion } from '../operator/operator-waiting.ts'

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

export function registerOperatorTools(server: McpServer): void {
  server.registerTool(
    'relay_question',
    {
      description: 'Mark an open run question as waiting on the operator.',
      inputSchema: {
        run_id: z.number().int().positive(),
        question_id: z.number().int().positive().optional(),
        note: z.string().trim().min(1),
      },
    },
    async ({ run_id, question_id, note }) =>
      text({ question_id: relayQuestion(run_id, question_id, note) }),
  )
}
