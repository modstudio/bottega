import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db, sessionId } from './db.ts'
import { consumeDoc, docsMarkdown, getDoc, listDocs, setDoc } from './docs.ts'
import { projectAt, projectByName, projects } from './projects.ts'
import {
  addDoctrineRule, addPair, addSkip, baselineForPair, ledgerRef, listDoctrineRules,
  listLedgerRefs, listSkips, pairByProjects, removeLedgerRef, resolveLedgerRef,
  retireDoctrineRule, setBaseline, setLedgerRef,
} from './porting.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

const HUB = resolve(new URL('../../bin/hub', import.meta.url).pathname)

const requiredReportField = (field: string, belongs: string) =>
  z.string({ error: `${field} is required: ${belongs}` }).trim()
    .min(1, `${field} is required: ${belongs}`)

const reporterFields = {
  reporter_kind: z.enum(['session', 'monitor']).optional(),
  monitor_invocation_id: z.number().int().positive().optional(),
  affected_project: z.string().trim().min(1).optional(),
}

type FileIssueInput = {
  kind: 'defect'
  what_happened: string
  expected: string
  reproduce_command: string
  environment: string
  evidence: string
  not_established: string
} | {
  kind: 'suggestion'
  what_happened: string
  expected: string
  evidence: string
  not_established: string
}

export type IssueReporter =
  | { kind: 'session' }
  | { kind: 'monitor'; invocationId: number; affectedProject: string }

function registeredProject(name: string) {
  const project = projectByName(name)
  if (!project) throw new Error(`unknown project "${name}"`)
  return project
}

function registeredPair(source: string, target: string, create = false) {
  const sourceProject = registeredProject(source)
  const targetProject = registeredProject(target)
  if (sourceProject.id === targetProject.id) {
    throw new Error('a port source and target must be different projects')
  }
  const pair = pairByProjects(sourceProject.id, targetProject.id)
    ?? (create ? addPair(sourceProject.id, targetProject.id) : null)
  return { sourceProject, targetProject, pair }
}

const ledgerSourceSchema = z.object({
  project: z.string().describe('Registered source project name.'),
  commits: z.array(z.string()),
  paths: z.array(z.string()),
  note: z.string(),
})

export async function fileIssue(input: FileIssueInput, reporter: IssueReporter = { kind: 'session' }) {
  if (reporter.kind !== 'session' && reporter.kind !== 'monitor') {
    throw new Error('unknown issue reporter kind')
  }
  const session = reporter.kind === 'session' ? sessionId() : null
  if (reporter.kind === 'session' && !session) {
    throw new Error('cannot file issue: the reporting session is not available')
  }
  if (reporter.kind === 'monitor') {
    const invocation = db().query('SELECT id FROM monitor_invocation WHERE id=?')
      .get(reporter.invocationId)
    if (!invocation) throw new Error(`no monitor invocation ${reporter.invocationId}`)
  }
  const project = projectAt(process.cwd())
  if (!project) {
    throw new Error(`cannot file issue: no registered project contains ${process.cwd()}`)
  }
  const type = input.kind.toUpperCase()
  const body = [
    `TYPE: ${type}`,
    ...(reporter.kind === 'session'
      ? [`REPORTER KIND: SESSION`, `REPORTING SESSION: ${session}`]
      : [`REPORTER KIND: MONITOR`, `REPORTING MONITOR INVOCATION: ${reporter.invocationId}`,
        `AFFECTED PROJECT: ${reporter.affectedProject}`]),
    `REPORTING PROJECT: ${project.name}`,
    '',
    'WHAT HAPPENED',
    input.what_happened,
    '',
    'EXPECTED INSTEAD',
    input.expected,
    ...(input.kind === 'defect' ? [
      '',
      'HOW TO REPRODUCE',
      `Command: ${input.reproduce_command}`,
      `Environment: ${input.environment}`,
    ] : []),
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
  return { key: stdout.trim(), kind: input.kind, session, project: project.name,
    reporter: reporter.kind,
    monitor_invocation_id: reporter.kind === 'monitor' ? reporter.invocationId : null }
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

  server.registerTool('inspect_port_baseline', {
    description: 'Inspect scan progress for one registered source-to-target project pair.',
    inputSchema: { source: z.string(), target: z.string() },
  }, async ({ source, target }) => {
    const { pair } = registeredPair(source, target)
    return text(pair ? { pair, baseline: baselineForPair(pair.id) } : null)
  })

  server.registerTool('set_port_baseline', {
    description: 'Set or clear scan progress for one registered source-to-target project pair.',
    inputSchema: {
      source: z.string(), target: z.string(), source_commit: z.string().nullable(),
    },
  }, async ({ source, target, source_commit }) => {
    const { pair } = registeredPair(source, target, true)
    return text({ pair, baseline: setBaseline(pair!.id, source_commit) })
  })

  server.registerTool('list_port_skips', {
    description: 'List declined candidates and reasons for a registered project pair.',
    inputSchema: { source: z.string(), target: z.string() },
  }, async ({ source, target }) => {
    const { pair } = registeredPair(source, target)
    return text(pair ? listSkips(pair.id) : [])
  })

  server.registerTool('record_port_skip', {
    description: 'Record a declined candidate and its reason for an existing project pair.',
    inputSchema: {
      source: z.string(), target: z.string(), candidate: z.string(), reason: z.string(),
    },
  }, async ({ source, target, candidate, reason }) => {
    const { pair } = registeredPair(source, target)
    if (!pair) throw new Error(`no port pair from "${source}" to "${target}"; set its baseline first`)
    return text(addSkip(pair.id, candidate, reason))
  })

  server.registerTool('list_port_ledger_refs', {
    description: 'List unresolved port ledger refs; include resolved refs only when requested.',
    inputSchema: { include_resolved: z.boolean().optional() },
  }, async ({ include_resolved }) => text(listLedgerRefs(include_resolved ?? false)))

  server.registerTool('get_port_ledger_ref', {
    description: 'Look up the source provenance recorded for a target task key.',
    inputSchema: { task_key: z.string() },
  }, async ({ task_key }) => text(ledgerRef(task_key)))

  server.registerTool('set_port_ledger_ref', {
    description: 'Record source projects, commits, paths, and notes for a staged target task.',
    inputSchema: { task_key: z.string(), note: z.string(), sources: z.array(ledgerSourceSchema).min(1) },
  }, async ({ task_key, note, sources }) => text(setLedgerRef({
    taskKey: task_key,
    note,
    sources: sources.map((source) => ({
      source_project_id: registeredProject(source.project).id,
      commits: source.commits,
      paths: source.paths,
      note: source.note,
    })),
  })))

  server.registerTool('resolve_port_ledger_ref', {
    description: 'Mark a staged target task resolved while preserving its source provenance.',
    inputSchema: { task_key: z.string() },
  }, async ({ task_key }) => {
    const ref = resolveLedgerRef(task_key)
    if (!ref) throw new Error(`no port ledger ref for task "${task_key}"`)
    return text(ref)
  })

  server.registerTool('delete_erroneous_port_ledger_ref', {
    description: 'Correction only: permanently delete a port ledger ref that was recorded in error.',
    inputSchema: { task_key: z.string() },
  }, async ({ task_key }) => text({ removed: removeLedgerRef(task_key) }))

  server.registerTool('list_port_doctrine', {
    description: 'List active doctrine rules; include retired stable numbers only when requested.',
    inputSchema: { include_retired: z.boolean().optional() },
  }, async ({ include_retired }) => text(listDoctrineRules(include_retired ?? false)))

  server.registerTool('add_port_doctrine_rule', {
    description: 'Add a numbered porting doctrine rule. Retired numbers cannot be reused.',
    inputSchema: { number: z.number().int().positive(), title: z.string(), body: z.string() },
  }, async ({ number, title, body }) => text(addDoctrineRule(number, title, body)))

  server.registerTool('retire_port_doctrine_rule', {
    description: 'Retire a doctrine rule without freeing its stable number.',
    inputSchema: { number: z.number().int().positive() },
  }, async ({ number }) => text({ retired: retireDoctrineRule(number) }))

  server.registerTool('file_issue', {
    description: `File an actionable defect or suggestion against ${PLATFORM_SLUG} through hub.`,
    inputSchema: z.discriminatedUnion('kind', [z.object({
      kind: z.literal('defect').describe('How the filed issue should be read.'),
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
      ...reporterFields,
    }), z.object({
      kind: z.literal('suggestion').describe('How the filed issue should be read.'),
      what_happened: requiredReportField(
        'what_happened', 'state the observed behavior or proposed change',
      ),
      expected: requiredReportField(
        'expected', 'state what should have happened or what the suggestion should achieve',
      ),
      evidence: requiredReportField(
        'evidence', 'provide concrete run ids, file:line pointers, or measured output',
      ),
      not_established: requiredReportField(
        'not_established', 'state what remains uncertain or has not been demonstrated',
      ),
      ...reporterFields,
    })]),
  }, async (input) => {
    const kind = input.reporter_kind ?? 'session'
    if (kind === 'monitor' && !input.monitor_invocation_id) {
      throw new Error('monitor_invocation_id is required for reporter_kind monitor')
    }
    if (kind === 'monitor' && !input.affected_project) {
      throw new Error('affected_project is required for reporter_kind monitor')
    }
    if (kind === 'session' && input.monitor_invocation_id) {
      throw new Error('monitor_invocation_id is only valid for reporter_kind monitor')
    }
    if (kind === 'session' && input.affected_project) {
      throw new Error('affected_project is only valid for reporter_kind monitor')
    }
    const { reporter_kind: _kind, monitor_invocation_id: _id, affected_project: _project, ...issue } = input
    const reporter: IssueReporter = kind === 'monitor'
      ? { kind, invocationId: input.monitor_invocation_id!, affectedProject: input.affected_project! } : { kind }
    return text(await fileIssue(issue, reporter))
  })

  return server
}

export async function serveDocsMcp(): Promise<void> {
  await createDocsMcpServer().connect(new StdioServerTransport())
}
