import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { sessionId } from './db.ts'
import { consumeDoc, docsMarkdown, getDoc, listDocs, setDoc } from './docs.ts'
import { projectAt, projectByName, projects } from './projects.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

const HUB = resolve(new URL('../../bin/hub', import.meta.url).pathname)

const requiredReportField = (field: string, belongs: string) =>
  z.string({ error: `${field} is required: ${belongs}` }).trim()
    .min(1, `${field} is required: ${belongs}`)

async function fileIssue(input: {
  kind: 'defect' | 'suggestion'
  what_happened: string
  expected: string
  reproduce_command: string
  environment: string
  evidence: string
  not_established: string
}) {
  const session = sessionId()
  if (!session) throw new Error('cannot file issue: the reporting session is not available')
  const project = projectAt(process.cwd())
  if (!project) {
    throw new Error(`cannot file issue: no registered project contains ${process.cwd()}`)
  }
  const type = input.kind.toUpperCase()
  const body = [
    `TYPE: ${type}`,
    `REPORTING SESSION: ${session}`,
    `REPORTING PROJECT: ${project.name}`,
    '',
    'WHAT HAPPENED',
    input.what_happened,
    '',
    'EXPECTED INSTEAD',
    input.expected,
    '',
    'HOW TO REPRODUCE',
    `Command: ${input.reproduce_command}`,
    `Environment: ${input.environment}`,
    '',
    'EVIDENCE',
    input.evidence,
    '',
    'WHAT IS NOT ESTABLISHED',
    input.not_established,
  ].join('\n')
  const child = Bun.spawn([
    HUB, 'task', 'new', '--project', PLATFORM_SLUG,
    '--title', `[${type}] ${input.what_happened}`,
    '--body', body,
  ], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`could not file issue through hub: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`)
  }
  return text({ key: stdout.trim(), kind: input.kind, session, project: project.name })
}

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

  server.registerTool('consume_doc', {
    description: 'Mark an operator document consumed without rewriting its body.',
    inputSchema: {
      scope: z.string(), subject: z.string().nullable().optional(), slug: z.string(),
    },
  }, async ({ scope, subject, slug }) => text(consumeDoc(scope, subject ?? null, slug)))

  server.registerTool('file_issue', {
    description: `File an actionable defect or suggestion against ${PLATFORM_SLUG} through hub.`,
    inputSchema: {
      kind: z.enum(['defect', 'suggestion']).describe('How the filed issue should be read.'),
      what_happened: requiredReportField(
        'what_happened', 'state the observed behavior or proposed change',
      ),
      expected: requiredReportField(
        'expected', 'state what should have happened or what the suggestion should achieve',
      ),
      reproduce_command: requiredReportField(
        'reproduce_command', 'provide the exact command that reproduces or demonstrates the issue',
      ),
      environment: requiredReportField(
        'environment', 'state the environment details that matter to reproducing the issue',
      ),
      evidence: requiredReportField(
        'evidence', 'provide concrete run ids, file:line pointers, or measured output',
      ),
      not_established: requiredReportField(
        'not_established', 'state what remains uncertain or has not been demonstrated',
      ),
    },
  }, fileIssue)

  return server
}

export async function serveDocsMcp(): Promise<void> {
  await createDocsMcpServer().connect(new StdioServerTransport())
}
