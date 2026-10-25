// concern: MCP doc consume adapter
/** Registers document consume and composes the optional resume-run handoff. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { consumeDoc } from '../doc/docs.ts'
import { handoffConsumedResumeBrief } from '../session/resume-brief-handoff.ts'
import { decideMcpDocWrite } from './mcp-doc-write.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export function registerMcpDocConsumeTool(server: McpServer): void {
  server.registerTool(
    'consume_doc',
    {
      description:
        'Mark an operator document consumed by rewriting its YAML status/stamps and updated_at.',
      inputSchema: z.object({
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      }),
    },
    async ({ scope, subject, slug }) => {
      const refusal = decideMcpDocWrite('consume_doc', scope)
      if (refusal) throw new Error(refusal)
      const result = await consumeDoc(scope, subject ?? null, slug, {
        reason: 'consumed by session',
      })
      const handoff =
        scope === 'resume' && !result.already_consumed
          ? await handoffConsumedResumeBrief(result)
          : null
      return text({ ...result, handoff })
    },
  )
}
