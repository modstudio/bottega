// concern: MCP doc consume adapter
/** Registers document consume and composes the optional resume-run handoff. */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { readDocForWrite } from '../doc/doc-authoritative-read.ts'
import type { ConsumeDocHandoff } from '../doc/doc-consume-command.ts'
import { resolveDocWriteSpace } from '../doc/doc-write-space.ts'
import { consumeDoc } from '../doc/docs.ts'
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
        space: z.string().trim().min(1).optional(),
      }),
    },
    async ({ scope, subject, slug, space }) => {
      const refusal = decideMcpDocWrite('consume_doc', scope)
      if (refusal) throw new Error(refusal)
      const selectedSpace = await resolveDocWriteSpace('consume_doc', space)
      const selected = await readDocForWrite(scope, subject, slug, null, selectedSpace)
      const finishHandoff = await handoff.prepare(selected.doc)
      const result = await consumeDoc(
        scope,
        subject,
        slug,
        {
          reason: 'consumed by session',
        },
        selected,
        selectedSpace,
      )
      const handoffResult = await finishHandoff(result)
      return text({ ...result, handoff: handoffResult })
    },
  )
}
