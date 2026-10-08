// concern: mcp-search-tools
/** Registers the semantic search tools; the retrieval work happens in the spawned retrieval command. */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { searchProjectCode } from '../code/code-search.ts'
import { searchDocs } from '../doc/doc-search.ts'
import { validateDocAddressFilter } from '../doc/docs.ts'
import { projectAt, projectByName } from '../project/projects.ts'

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    'search_docs',
    {
      description: 'Find docs by meaning and return addresses to open with get_doc.',
      inputSchema: z.object({
        query: z.string().trim().min(1),
        k: z.number().int().positive().optional(),
        scope: z.string().trim().min(1).optional(),
        subject: z.string().trim().min(1).optional(),
        includeDrafts: z.boolean().optional(),
      }),
    },
    async ({ query, k, scope, subject, includeDrafts }) => {
      const filter = { scope, subject, includeDrafts }
      validateDocAddressFilter(filter)
      return text(await searchDocs(query, k ?? 5, filter))
    },
  )

  server.registerTool(
    'search_code',
    {
      description: 'Find code by meaning and return repository paths and line ranges to open.',
      inputSchema: z.object({
        query: z.string().trim().min(1),
        project: z.string().trim().min(1).optional(),
        k: z.number().int().positive().optional(),
      }),
    },
    async ({ query, project, k }) => {
      const cwd = process.cwd()
      const callerProject = projectAt(cwd)
      const selected = project ? projectByName(project) : callerProject
      if (!selected) {
        throw new Error(
          project
            ? `no project "${project}"`
            : 'the working directory is not inside a registered project; pass project',
        )
      }
      if (callerProject?.name !== selected.name) {
        throw new Error(
          `the caller's checkout does not belong to project ${selected.name}; run from that project's checkout`,
        )
      }
      return text(await searchProjectCode(selected, cwd, query, k ?? 5))
    },
  )
}
