// concern: MCP doc consume adapter
/** Registers document consume and composes the optional resume-run handoff. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ConsumeDocHandoff } from '../doc/doc-consume-command.ts'
import { consumeDoc, getDoc } from '../doc/docs.ts'
import { resumeBriefHandoff } from '../session/resume-brief-handoff.ts'
import { decideMcpDocWrite } from './mcp-doc-write.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
})

export function registerMcpDocConsumeTool(
  server: McpServer,
  handoff: ConsumeDocHandoff = resumeBriefHandoff,
): void {
  server.registerTool(
    'consume_doc',
    {
      description:
        "Mark a resume brief consumed and hand its author's owed runs (live, pending a score, or still holding a branch or run resource) to the consuming session; finished runs stay with the author.",
      inputSchema: z.object({
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      }),
    },
    async ({ scope, subject, slug }) => {
      const refusal = decideMcpDocWrite('consume_doc', scope)
      if (refusal) throw new Error(refusal)
      const finishHandoff = await handoff.prepare(getDoc(scope, subject ?? null, slug))
      const result = await consumeDoc(scope, subject ?? null, slug, {
        reason: 'consumed by session',
      })
      const handoffResult = await finishHandoff(result)
      return text({ ...result, handoff: handoffResult })
    },
  )
}
