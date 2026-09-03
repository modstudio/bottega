import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { docsMarkdown, getDoc, listDocs, setDoc } from './docs.ts'
import { projectByName, projects } from './projects.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

export function createDocsMcpServer(): McpServer {
  const server = new McpServer({ name: 'orch', version: '0.1.0' })

  server.registerTool('list_projects', {
    description: 'List projects registered with the orchestrator.',
  }, async () => text(projects()))

  server.registerTool('project_brief', {
    description: 'Get a registered project row and its operator documents.',
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const project = projectByName(name)
    if (!project) throw new Error(`unknown project "${name}"`)
    const markdown = docsMarkdown(listDocs({ scope: 'project', subject: name }))
    return text(`${JSON.stringify(project)}${markdown ? `\n\n${markdown}` : ''}`)
  })

  server.registerTool('list_docs', {
    description: 'List operator documents, optionally filtered by scope and subject.',
    inputSchema: { scope: z.string().optional(), subject: z.string().nullable().optional() },
  }, async ({ scope, subject }) => text(listDocs({ scope, subject })))

  server.registerTool('get_doc', {
    description: 'Get one operator document.',
    inputSchema: {
      scope: z.string(), subject: z.string().nullable().optional(), slug: z.string(),
    },
  }, async ({ scope, subject, slug }) => {
    const doc = getDoc(scope, subject ?? null, slug)
    if (!doc) throw new Error(`no ${scope} doc "${slug}"`)
    return text(doc)
  })

  server.registerTool('set_doc', {
    description: 'Create or replace an operator document.',
    inputSchema: {
      scope: z.string(), subject: z.string().nullable().optional(), slug: z.string(),
      title: z.string(), body: z.string(),
    },
  }, async ({ scope, subject, slug, title, body }) =>
    text(setDoc({ scope, subject: subject ?? null, slug, title, body })))

  return server
}

export async function serveDocsMcp(): Promise<void> {
  await createDocsMcpServer().connect(new StdioServerTransport())
}
