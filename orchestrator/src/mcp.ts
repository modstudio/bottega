import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db, sessionId } from './db.ts'
import {
  consumeDoc, docsMarkdown, getDoc, getDocRevision, listDocMetadata, listDocRevisions, listDocs, setDoc,
} from './docs.ts'
import { projectAt, projectByName, projects } from './projects.ts'
import {
  addDoctrineRule, addPair, addSkip, baselineForPair, ledgerRef, listDoctrineRules,
  listLedgerRefs, listSkips, pairByProjects, removeLedgerRef, resolveLedgerRef,
  retireDoctrineRule, setBaseline, setLedgerRef,
} from './porting.ts'
import { composeWorkflow, getWorkflowStep, listWorkflows } from './workflows.ts'
import { checkDoc, repoRootForDoc } from './canon.ts'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

const HUB = resolve(new URL('../../bin/hub', import.meta.url).pathname)

const requiredReportField = (field: string, belongs: string) =>
  z.string({ error: `${field} is required: ${belongs}` }).trim()
    .min(1, `${field} is required: ${belongs}`)

const reporterFields = {
  reporter_kind: z.enum(['session', 'worker', 'monitor']).optional()
    .describe('Omit for the calling session; worker identity is derived from the orch run environment.'),
  monitor_invocation_id: z.number().int().positive().optional(),
  affected_project: z.string().trim().min(1).optional(),
  reporting_project: z.string().trim().min(1).optional()
    .describe('Registered project name. Omit to derive it from the current working directory.'),
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

type HubTask = {
  key: string
  project: string
  title: string | null
  status: string | null
}

export type DuplicateCandidate = {
  key: string
  status: string | null
  title: string
  score: number
}

const DUPLICATE_STOP_WORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was were will with should before after not no'.split(' '),
)

// Provisional, measured against the real reports that prompted DEV-267:
// DEV-209/DEV-210 scored 0.248, DEV-265/DEV-266 scored 0.227, and the best
// unrelated result across those four searches scored 0.151.
const DUPLICATE_THRESHOLD = 0.20
const DUPLICATE_LIMIT = 3

function titleTokens(title: string): Set<string> {
  return new Set(
    (title.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => token.length > 1 && !DUPLICATE_STOP_WORDS.has(token)),
  )
}

function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

export function duplicateCandidates(tasks: HubTask[], title: string): DuplicateCandidate[] {
  return tasks
    .filter((task): task is HubTask & { title: string } => !!task.title)
    .map((task) => ({
      key: task.key,
      status: task.status,
      title: task.title,
      score: titleSimilarity(title, task.title),
    }))
    .filter((candidate) => candidate.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, DUPLICATE_LIMIT)
}

async function hubOutput(args: string[]): Promise<string> {
  const child = Bun.spawn([HUB, ...args], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `hub exited ${exitCode}`)
  }
  return stdout
}

async function searchDuplicateIssues(title: string): Promise<
  { duplicates: DuplicateCandidate[]; error: null } | { duplicates: null; error: string }
> {
  try {
    const output = await hubOutput(['task', 'list', '--project', PLATFORM_SLUG, '--json'])
    const tasks = JSON.parse(output) as HubTask[]
    if (!Array.isArray(tasks)) throw new Error('hub task list returned a non-array JSON value')
    return { duplicates: duplicateCandidates(tasks, title), error: null }
  } catch (error) {
    return { duplicates: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export type IssueReporter =
  | { kind: 'session' }
  | { kind: 'worker' }
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

export async function fileIssue(
  input: FileIssueInput,
  reporter: IssueReporter = { kind: 'session' },
  reportingProject?: string,
) {
  if (reporter.kind !== 'session' && reporter.kind !== 'worker' && reporter.kind !== 'monitor') {
    throw new Error('unknown issue reporter kind')
  }
  const session = reporter.kind === 'session' ? sessionId() : null
  if (reporter.kind === 'session' && !session) {
    throw new Error('cannot file issue: the reporting session is not available')
  }
  let reporterId: string | number = session ?? ''
  if (reporter.kind === 'worker') {
    // Identity is observed from the launcher's environment, never accepted as
    // a tool argument. The token proves this process belongs to that run.
    const runId = Number(process.env.ORCH_RUN_ID ?? 0)
    const token = process.env.ORCH_RUN_TOKEN ?? ''
    const run = runId
      ? db().query('SELECT id, run_token FROM run WHERE id=?').get(runId) as
        { id: number; run_token: string | null } | null
      : null
    if (!run || (run.run_token && run.run_token !== token)) {
      throw new Error('cannot file issue: the reporting worker is not available')
    }
    reporterId = run.id
  } else if (reporter.kind === 'monitor') {
    const invocation = db().query('SELECT id FROM monitor_invocation WHERE id=?')
      .get(reporter.invocationId)
    if (!invocation) throw new Error(`no monitor invocation ${reporter.invocationId}`)
    reporterId = reporter.invocationId
  }
  const project = reportingProject ? registeredProject(reportingProject) : projectAt(process.cwd())
  if (!project) {
    throw new Error(`cannot file issue: no registered project contains ${process.cwd()}`)
  }
  const type = input.kind.toUpperCase()
  const title = `[${type}] ${input.what_happened}`
  const duplicateSearch = await searchDuplicateIssues(title)
  const duplicateRecord = duplicateSearch.duplicates?.length
    ? [
        '',
        'SUSPECTED DUPLICATES',
        ...duplicateSearch.duplicates.map((candidate) =>
          `- ${candidate.key} [${candidate.status ?? 'unknown'}] ${candidate.title.replace(/\s+/g, ' ').trim()}`),
      ]
    : duplicateSearch.error
      ? ['', 'DUPLICATE SEARCH FAILED', duplicateSearch.error]
      : []
  const body = [
    `TYPE: ${type}`,
    ...(reporter.kind === 'session'
      ? [`REPORTER KIND: SESSION`, `REPORTING SESSION: ${session}`]
      : reporter.kind === 'worker'
        ? [`REPORTER KIND: WORKER`, `REPORTING WORKER RUN: ${reporterId}`]
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
    ...duplicateRecord,
  ].join('\n')
  let stdout: string
  try {
    stdout = await hubOutput([
      'task', 'new', '--project', PLATFORM_SLUG, '--title', title, '--body', body,
    ])
  } catch (error) {
    throw new Error(`could not file issue through hub: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { key: stdout.trim(), kind: input.kind, session, project: project.name,
    reporter: reporter.kind, reporter_id: reporterId,
    worker_run_id: reporter.kind === 'worker' ? reporterId : null,
    monitor_invocation_id: reporter.kind === 'monitor' ? reporter.invocationId : null,
    ...(duplicateSearch.duplicates === null
      ? { duplicate_search_error: duplicateSearch.error }
      : { duplicates: duplicateSearch.duplicates }) }
}

export function createDocsMcpServer(): McpServer {
  const server = new McpServer({ name: 'orch', version: '0.1.0' })

  server.registerTool('list_workflows', {
    description: 'List workflow identities and their production and draft versions.',
  }, async () => text(listWorkflows()))

  server.registerTool('compose_workflow', {
    description: 'Compose a workflow index without returning step bodies.',
    inputSchema: {
      slug: z.string().trim().min(1), mode: z.string().trim().min(1).optional(),
      args: z.record(z.string(), z.string()).optional(),
    },
  }, async ({ slug, mode, args }) => text(composeWorkflow(slug, mode, args ?? {})))

  server.registerTool('get_workflow_step', {
    description: 'Fetch one reached workflow step with argument substitutions applied.',
    inputSchema: {
      slug: z.string().trim().min(1), step: z.string().trim().min(1),
      args: z.record(z.string(), z.string()).optional(),
    },
  }, async ({ slug, step, args }) => text(getWorkflowStep(slug, step, args ?? {})))

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
    description: 'List operator document metadata without bodies. Use get_doc to fetch one body.',
    inputSchema: {
      scope: z.string().optional().describe('Exact scope match.'),
      subject: z.string().nullable().optional().describe('Exact subject match.'),
      scopes: z.array(z.string()).optional().describe('Exact match against any of these scopes.'),
      match: z.string().optional().describe('Case-insensitive substring match on title, slug, or subject.'),
      body_match: z.string().optional().describe('Case-insensitive substring match on body; bodies stay omitted.'),
      updated_at_order: z.enum(['asc', 'desc']).optional()
        .describe('Order by updated_at; omit for scope, subject, slug order.'),
    },
  }, async ({ scope, subject, scopes, match, body_match, updated_at_order }) => text(listDocMetadata({
    scope, subject, scopes, match, bodyMatch: body_match, updatedAtOrder: updated_at_order,
  })))

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
      delivery: z.enum(['inject', 'demand']).optional(),
      reason: z.string({ error: 'reason is required: explain why this operator doc is changing' }).trim()
        .min(1, 'reason is required: explain why this operator doc is changing'),
      author: z.string().trim().min(1).optional(),
    },
  }, async ({ scope, subject, slug, title, body, delivery, reason, author }) => {
    const doc = setDoc({ scope, subject: subject ?? null, slug, title, body, delivery, reason, author })
    const root = repoRootForDoc(doc)
    return text({ ...doc, warnings: root ? checkDoc(body, { repoRoot: root }) : [] })
  })

  server.registerTool('consume_doc', {
    description: 'Mark an operator document consumed by rewriting its YAML status/stamps and updated_at.',
    inputSchema: {
      scope: z.string(), subject: z.string().nullable().optional(), slug: z.string(),
    },
  }, async ({ scope, subject, slug }) => text(consumeDoc(
    scope, subject ?? null, slug, { reason: 'consumed by session' },
  )))

  server.registerTool('list_doc_revisions', {
    description: 'List revision metadata for one operator document, newest first; bodies are omitted.',
    inputSchema: {
      scope: z.string(), subject: z.string().nullable().optional(), slug: z.string(),
    },
  }, async ({ scope, subject, slug }) => text(listDocRevisions(scope, subject ?? null, slug)))

  server.registerTool('get_doc_revision', {
    description: 'Get one operator document revision, including its body.',
    inputSchema: { id: z.number().int().positive() },
  }, async ({ id }) => {
    const revision = getDocRevision(id)
    if (!revision) throw new Error(`no doc revision ${id}`)
    return text(revision)
  })

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
    description: `File an actionable defect or suggestion against ${PLATFORM_SLUG} through hub, returning likely duplicate tasks.`,
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
    if (kind !== 'monitor' && input.affected_project) {
      throw new Error('affected_project is only valid for reporter_kind monitor')
    }
    const { reporter_kind: _kind, monitor_invocation_id: _id, affected_project: _project,
      reporting_project: _reportingProject, ...issue } = input
    const reporter: IssueReporter = kind === 'monitor'
      ? { kind, invocationId: input.monitor_invocation_id!, affectedProject: input.affected_project! }
      : { kind }
    return text(await fileIssue(issue, reporter, input.reporting_project))
  })

  return server
}

export async function serveDocsMcp(): Promise<void> {
  await createDocsMcpServer().connect(new StdioServerTransport())
}
