import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db, enableSchemaReload, sessionId } from './db.ts'
import { registerStandardRuntime } from './runtime-registration.ts'

registerStandardRuntime()

import { strictlyAuthenticatedWorkerRun } from './ask.ts'
import { checkDoc, repoRootForDoc } from './canon.ts'
import {
  consumeDoc,
  docsMarkdown,
  getDoc,
  getDocRevision,
  listDocMetadata,
  listDocRevisions,
  listDocs,
  setDoc,
} from './doc/docs.ts'
import { filedIssueDataLine } from './issue/issue.ts'
import {
  CONDITIONAL_ISSUE_REPORT_FIELD_REASONS,
  missingIssueReportFields,
} from './issue/issue-report-fields.ts'
import { resolveLens } from './lens/lenses.ts'
import { decideMcpDocWrite } from './mcp-doc-write.ts'
import {
  addDoctrineRule,
  addPair,
  addSkip,
  baselineForPair,
  ledgerRef,
  listDoctrineRules,
  listLedgerRefs,
  listSkips,
  pairByProjects,
  removeLedgerRef,
  resolveLedgerRef,
  retireDoctrineRule,
  setBaseline,
  setLedgerRef,
} from './porting/porting.ts'
import { projectAt, projectByName, projects } from './projects.ts'
import { getReview, listReviews } from './review.ts'
import { composeWorkflow, getWorkflowStep, listWorkflows } from './workflow/workflows.ts'

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
})

const HUB = resolve(new URL('../../bin/hub', import.meta.url).pathname)

const requiredReportField = (field: string, belongs: string) =>
  z
    .string({ error: `${field} is required: ${belongs}` })
    .trim()
    .min(1, `${field} is required: ${belongs}`)

const reporterFields = {
  reporter_kind: z
    .enum(['session', 'monitor'])
    .optional()
    .describe(
      'Omit to derive the calling session or authenticated orch worker from the environment.',
    ),
  monitor_invocation_id: z.number().int().positive().optional(),
  affected_project: z.string().trim().min(1).optional(),
  reporting_project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Registered project name. Omit to derive it from the current working directory.'),
}

type FileIssueInput =
  | {
      kind: 'defect'
      title?: string
      what_happened: string
      expected: string
      reproduce_command: string
      environment: string
      evidence: string
      not_established: string
    }
  | {
      kind: 'suggestion'
      title?: string
      what_happened: string
      expected: string
      evidence: string
      not_established: string
    }

export type DuplicateCandidate = {
  key: string
  status: string | null
  title: string
  score: number
}

const FILED_ISSUE_TITLE_MAX = 200

function filedIssueTitle(input: FileIssueInput) {
  const submitted = input.title
  const normalized = (submitted?.trim() ? submitted : input.what_happened)
    .replace(/\s+/g, ' ')
    .trim()
  const prefixed = `[${input.kind.toUpperCase()}] ${normalized}`
  const shortened = prefixed.length > FILED_ISSUE_TITLE_MAX
  return {
    title: shortened ? `${prefixed.slice(0, FILED_ISSUE_TITLE_MAX - 1).trimEnd()}…` : prefixed,
    shortened,
  }
}

async function hubOutput(args: string[], cwd = process.cwd()): Promise<string> {
  const child = Bun.spawn([HUB, ...args], {
    cwd,
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
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

export async function fileNote(input: { text: string; same_as?: number; new?: boolean }) {
  if (input.same_as && input.new) throw new Error('same_as and new are mutually exclusive')
  let cwd = process.cwd()
  const runId = Number(process.env.ORCH_RUN_ID ?? 0)
  const token = process.env.ORCH_RUN_TOKEN ?? ''
  if (runId > 0 && strictlyAuthenticatedWorkerRun(runId, token)) {
    const worker = db()
      .query<{ launch_cwd: string | null }, [number]>('SELECT launch_cwd FROM run WHERE id=?')
      .get(runId)
    if (worker?.launch_cwd) cwd = worker.launch_cwd
  }
  if (!projectAt(cwd)) throw new Error(`cannot file note: no registered project contains ${cwd}`)
  const args = [
    'note',
    'new',
    input.text,
    ...(input.same_as ? ['--same-as', String(input.same_as)] : input.new ? ['--new'] : []),
  ]
  return { output: (await hubOutput(args, cwd)).trim() }
}

async function searchDuplicateIssues(
  title: string,
): Promise<
  { duplicates: DuplicateCandidate[]; error: null } | { duplicates: null; error: string }
> {
  try {
    const output = await hubOutput([
      'task',
      'duplicates',
      '--project',
      PLATFORM_SLUG,
      '--title',
      title,
      '--json',
    ])
    const duplicates = JSON.parse(output) as DuplicateCandidate[]
    if (!Array.isArray(duplicates))
      throw new Error('hub task duplicates returned a non-array JSON value')
    return { duplicates, error: null }
  } catch (error) {
    return { duplicates: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export type IssueReporter =
  | { kind: 'session' }
  | { kind: 'monitor'; invocationId: number; affectedProject: string }

type WorkerReporter = {
  id: number
  job: string
  agent: string
  launch_cwd: string | null
  launch_key: string | null
}

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
  const pair =
    pairByProjects(sourceProject.id, targetProject.id) ??
    (create ? addPair(sourceProject.id, targetProject.id) : null)
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
  if (reporter.kind !== 'session' && reporter.kind !== 'monitor') {
    throw new Error('unknown issue reporter kind')
  }
  const session = reporter.kind === 'session' ? sessionId() : null
  let worker: WorkerReporter | null = null
  let reporterId: string | number = session ?? ''
  if (reporter.kind === 'session' && !session) {
    const runId = Number(process.env.ORCH_RUN_ID ?? 0)
    const token = process.env.ORCH_RUN_TOKEN ?? ''
    if (!strictlyAuthenticatedWorkerRun(runId, token)) {
      throw new Error('cannot file issue: the reporting session is not available')
    }
    worker = db()
      .query('SELECT id, job, agent, launch_cwd, launch_key FROM run WHERE id=?')
      .get(runId) as WorkerReporter | null
    if (!worker?.launch_cwd) {
      throw new Error('cannot file issue: the reporting worker has no project origin')
    }
    reporterId = `run:${worker.id}`
  } else if (reporter.kind === 'monitor') {
    const invocation = db()
      .query('SELECT id FROM monitor_invocation WHERE id=?')
      .get(reporter.invocationId)
    if (!invocation) throw new Error(`no monitor invocation ${reporter.invocationId}`)
    reporterId = reporter.invocationId
  }
  const project = worker
    ? projectAt(worker.launch_cwd!)
    : reportingProject
      ? registeredProject(reportingProject)
      : projectAt(process.cwd())
  if (!project) {
    const cwd = worker?.launch_cwd ?? process.cwd()
    throw new Error(`cannot file issue: no registered project contains ${cwd}`)
  }
  const type = input.kind.toUpperCase()
  const { title, shortened: titleShortened } = filedIssueTitle(input)
  const duplicateSearch = await searchDuplicateIssues(title)
  const duplicateRecord = duplicateSearch.duplicates?.length
    ? [
        '',
        'SUSPECTED DUPLICATES',
        ...duplicateSearch.duplicates.map(
          (candidate) =>
            `- ${candidate.key} [${candidate.status ?? 'unknown'}] ${candidate.title.replace(/\s+/g, ' ').trim()}`,
        ),
      ]
    : duplicateSearch.error
      ? ['', 'DUPLICATE SEARCH FAILED', duplicateSearch.error]
      : []
  const filedFields = [
    ...(worker
      ? [
          `Filed by orch run ${worker.id} (${worker.job}, ${worker.agent}) while working ${
            worker.launch_key ?? 'with no task key'
          }`,
        ]
      : []),
    `TYPE: ${type}`,
    ...(worker
      ? [`REPORTER KIND: WORKER`, `REPORTING WORKER RUN: ${reporterId}`]
      : reporter.kind === 'session'
        ? [`REPORTER KIND: SESSION`, `REPORTING SESSION: ${session}`]
        : [
            `REPORTER KIND: MONITOR`,
            `REPORTING MONITOR INVOCATION: ${reporter.invocationId}`,
            `AFFECTED PROJECT: ${reporter.affectedProject}`,
          ]),
    `REPORTING PROJECT: ${project.name}`,
    '',
    'WHAT HAPPENED',
    input.what_happened,
    '',
    'EXPECTED INSTEAD',
    input.expected,
    ...(input.kind === 'defect'
      ? [
          '',
          'HOW TO REPRODUCE',
          `Command: ${input.reproduce_command}`,
          `Environment: ${input.environment}`,
        ]
      : []),
    '',
    'EVIDENCE',
    input.evidence,
    '',
    'WHAT IS NOT ESTABLISHED',
    input.not_established,
  ].join('\n')
  const body = [
    filedIssueDataLine({
      version: 1,
      kind: input.kind,
      reporting_project: project.name,
      submitted_title: input.title ?? null,
      what_happened: input.what_happened,
      expected: input.expected,
      reproduce_command: input.kind === 'defect' ? input.reproduce_command : null,
      environment: input.kind === 'defect' ? input.environment : null,
      evidence: input.evidence,
      not_established: input.not_established,
    }),
    '',
    filedFields,
    ...duplicateRecord,
    ...(input.title === undefined ? [] : ['', 'SUBMITTED TITLE', input.title]),
    '',
    `FILED FIELDS LENGTH: ${filedFields.length}`,
  ].join('\n')
  let stdout: string
  try {
    stdout = await hubOutput([
      'task',
      'new',
      '--project',
      PLATFORM_SLUG,
      '--title',
      title,
      '--body',
      body,
      '--allow-duplicate',
      'orchestrator file_issue',
    ])
  } catch (error) {
    throw new Error(
      `could not file issue through hub: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return {
    key: stdout.trim(),
    kind: input.kind,
    session,
    project: project.name,
    title,
    title_shortened: titleShortened,
    reporter: worker ? 'worker' : reporter.kind,
    reporter_id: reporterId,
    worker_run_id: worker?.id ?? null,
    ...(worker ? { origin: worker.launch_key } : {}),
    monitor_invocation_id: reporter.kind === 'monitor' ? reporter.invocationId : null,
    ...(duplicateSearch.duplicates === null
      ? { duplicate_search_error: duplicateSearch.error }
      : { duplicates: duplicateSearch.duplicates }),
  }
}

export function createDocsMcpServer(): McpServer {
  const server = new McpServer({ name: 'orch', version: '0.1.0' })
  enableSchemaReload((from, to) => {
    console.error(
      `schema changed: re-preparing statements and re-advertising tools (user_version ${from} -> ${to})`,
    )
    server.sendToolListChanged()
  })
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: object,
    handler: (...args: never[]) => Promise<unknown>,
  ) => unknown
  server.registerTool = ((
    name: string,
    config: object,
    handler: (...args: never[]) => Promise<unknown>,
  ) =>
    registerTool(name, config, async (...args: never[]) => {
      db()
      return handler(...args)
    })) as typeof server.registerTool

  server.registerTool(
    'list_workflows',
    {
      description: 'List workflow identities and their production and draft versions.',
    },
    async () => text(listWorkflows()),
  )

  server.registerTool(
    'compose_workflow',
    {
      description: 'Compose a workflow index without returning step bodies.',
      inputSchema: {
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ slug, project, mode, args }) => text(composeWorkflow(slug, project, mode, args ?? {})),
  )

  server.registerTool(
    'get_workflow_step',
    {
      description: 'Fetch one reached workflow step with argument substitutions applied.',
      inputSchema: {
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        step: z.string().trim().min(1),
        args: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ slug, project, step, args }) => text(getWorkflowStep(slug, project, step, args ?? {})),
  )

  server.registerTool(
    'list_projects',
    {
      description: 'List projects registered with the orchestrator.',
    },
    async () => text(projects()),
  )

  server.registerTool(
    'get_lens',
    {
      description:
        'Get one resolved sealed lens core and the selected profile names for a registered project.',
      inputSchema: { id: z.string().trim().min(1), project: z.string().trim().min(1) },
    },
    async ({ id, project }) => {
      if (!projectByName(project)) throw new Error(`unknown project "${project}"`)
      const lens = resolveLens(id, project)
      if (!lens) throw new Error(`no catalogue lens "${id}"`)
      return text(lens)
    },
  )

  server.registerTool(
    'list_reviews',
    {
      description: 'List review records, findings counts, and current branch coverage.',
      inputSchema: {
        open: z.boolean().optional(),
        complete: z.boolean().optional(),
        project: z.string().trim().min(1).optional(),
        since: z.iso.datetime().optional(),
      },
    },
    async ({ open, complete, project, since }) => {
      if (open && complete) throw new Error('open and complete are mutually exclusive')
      return text(
        listReviews({ state: open ? 'open' : complete ? 'complete' : undefined, project, since }),
      )
    },
  )

  server.registerTool(
    'get_review',
    {
      description:
        'Get one review with all lenses, grading flags, findings, evidence, and pin state.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => text(getReview(id)),
  )

  server.registerTool(
    'project_brief',
    {
      description: 'Get a registered project row and its operator documents.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const project = projectByName(name)
      if (!project) throw new Error(`unknown project "${name}"`)
      const markdown = docsMarkdown(listDocs({ scope: 'project', subject: name }))
      return text(`${JSON.stringify(project)}${markdown ? `\n\n${markdown}` : ''}`)
    },
  )

  server.registerTool(
    'list_docs',
    {
      description: 'List operator document metadata without bodies. Use get_doc to fetch one body.',
      inputSchema: {
        scope: z.string().optional().describe('Exact scope match.'),
        subject: z.string().nullable().optional().describe('Exact subject match.'),
        scopes: z.array(z.string()).optional().describe('Exact match against any of these scopes.'),
        match: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on title, slug, or subject.'),
        body_match: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on body; bodies stay omitted.'),
        updated_at_order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Order by updated_at; omit for scope, subject, slug order.'),
      },
    },
    async ({ scope, subject, scopes, match, body_match, updated_at_order }) =>
      text(
        listDocMetadata({
          scope,
          subject,
          scopes,
          match,
          bodyMatch: body_match,
          updatedAtOrder: updated_at_order,
        }),
      ),
  )

  server.registerTool(
    'get_doc',
    {
      description: 'Get one operator document.',
      inputSchema: {
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      },
    },
    async ({ scope, subject, slug }) => {
      const doc = getDoc(scope, subject ?? null, slug)
      if (!doc) throw new Error(`no ${scope} doc "${slug}"`)
      return text(doc)
    },
  )

  server.registerTool(
    'set_doc',
    {
      description: 'Create or replace an operator document.',
      inputSchema: {
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
        title: z.string(),
        body: z.string(),
        delivery: z.enum(['inject', 'demand']).optional(),
        force_inject: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Required justification when an injected document exceeds the write-time size threshold.',
          ),
        reason: z
          .string({ error: 'reason is required: explain why this operator doc is changing' })
          .trim()
          .min(1, 'reason is required: explain why this operator doc is changing'),
        author: z.string().trim().min(1).optional(),
      },
    },
    async ({ scope, subject, slug, title, body, delivery, force_inject, reason, author }) => {
      const refusal = decideMcpDocWrite('set_doc', scope)
      if (refusal) throw new Error(refusal)
      const doc = await setDoc({
        scope,
        subject: subject ?? null,
        slug,
        title,
        body,
        delivery,
        forceInject: force_inject,
        reason,
        author,
      })
      const root = repoRootForDoc(doc)
      return text({ ...doc, warnings: root ? checkDoc(body, { repoRoot: root }) : [] })
    },
  )

  server.registerTool(
    'consume_doc',
    {
      description:
        'Mark an operator document consumed by rewriting its YAML status/stamps and updated_at.',
      inputSchema: {
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      },
    },
    async ({ scope, subject, slug }) => {
      const refusal = decideMcpDocWrite('consume_doc', scope)
      if (refusal) throw new Error(refusal)
      return text(await consumeDoc(scope, subject ?? null, slug, { reason: 'consumed by session' }))
    },
  )

  server.registerTool(
    'list_doc_revisions',
    {
      description:
        'List revision metadata for one operator document, newest first; bodies are omitted.',
      inputSchema: {
        scope: z.string(),
        subject: z.string().nullable().optional(),
        slug: z.string(),
      },
    },
    async ({ scope, subject, slug }) => text(listDocRevisions(scope, subject ?? null, slug)),
  )

  server.registerTool(
    'get_doc_revision',
    {
      description: 'Get one operator document revision, including its body.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      const revision = getDocRevision(id)
      if (!revision) throw new Error(`no doc revision ${id}`)
      return text(revision)
    },
  )

  server.registerTool(
    'inspect_port_baseline',
    {
      description: 'Inspect scan progress for one registered source-to-target project pair.',
      inputSchema: { source: z.string(), target: z.string() },
    },
    async ({ source, target }) => {
      const { pair } = registeredPair(source, target)
      return text(pair ? { pair, baseline: baselineForPair(pair.id) } : null)
    },
  )

  server.registerTool(
    'set_port_baseline',
    {
      description: 'Set or clear scan progress for one registered source-to-target project pair.',
      inputSchema: {
        source: z.string(),
        target: z.string(),
        source_commit: z.string().nullable(),
      },
    },
    async ({ source, target, source_commit }) => {
      const { pair } = registeredPair(source, target, true)
      return text({ pair, baseline: setBaseline(pair!.id, source_commit) })
    },
  )

  server.registerTool(
    'list_port_skips',
    {
      description: 'List declined candidates and reasons for a registered project pair.',
      inputSchema: { source: z.string(), target: z.string() },
    },
    async ({ source, target }) => {
      const { pair } = registeredPair(source, target)
      return text(pair ? listSkips(pair.id) : [])
    },
  )

  server.registerTool(
    'record_port_skip',
    {
      description: 'Record a declined candidate and its reason for an existing project pair.',
      inputSchema: {
        source: z.string(),
        target: z.string(),
        candidate: z.string(),
        reason: z.string(),
      },
    },
    async ({ source, target, candidate, reason }) => {
      const { pair } = registeredPair(source, target)
      if (!pair)
        throw new Error(`no port pair from "${source}" to "${target}"; set its baseline first`)
      return text(addSkip(pair.id, candidate, reason))
    },
  )

  server.registerTool(
    'list_port_ledger_refs',
    {
      description: 'List unresolved port ledger refs; include resolved refs only when requested.',
      inputSchema: { include_resolved: z.boolean().optional() },
    },
    async ({ include_resolved }) => text(listLedgerRefs(include_resolved ?? false)),
  )

  server.registerTool(
    'get_port_ledger_ref',
    {
      description: 'Look up the source provenance recorded for a target task key.',
      inputSchema: { task_key: z.string() },
    },
    async ({ task_key }) => text(ledgerRef(task_key)),
  )

  server.registerTool(
    'set_port_ledger_ref',
    {
      description: 'Record source projects, commits, paths, and notes for a staged target task.',
      inputSchema: {
        task_key: z.string(),
        note: z.string(),
        sources: z.array(ledgerSourceSchema).min(1),
      },
    },
    async ({ task_key, note, sources }) =>
      text(
        setLedgerRef({
          taskKey: task_key,
          note,
          sources: sources.map((source) => ({
            source_project_id: registeredProject(source.project).id,
            commits: source.commits,
            paths: source.paths,
            note: source.note,
          })),
        }),
      ),
  )

  server.registerTool(
    'resolve_port_ledger_ref',
    {
      description: 'Mark a staged target task resolved while preserving its source provenance.',
      inputSchema: { task_key: z.string() },
    },
    async ({ task_key }) => {
      const ref = resolveLedgerRef(task_key)
      if (!ref) throw new Error(`no port ledger ref for task "${task_key}"`)
      return text(ref)
    },
  )

  server.registerTool(
    'delete_erroneous_port_ledger_ref',
    {
      description:
        'Correction only: permanently delete a port ledger ref that was recorded in error.',
      inputSchema: { task_key: z.string() },
    },
    async ({ task_key }) => text({ removed: removeLedgerRef(task_key) }),
  )

  server.registerTool(
    'list_port_doctrine',
    {
      description:
        'List active doctrine rules; include retired stable numbers only when requested.',
      inputSchema: { include_retired: z.boolean().optional() },
    },
    async ({ include_retired }) => text(listDoctrineRules(include_retired ?? false)),
  )

  server.registerTool(
    'add_port_doctrine_rule',
    {
      description: 'Add a numbered porting doctrine rule. Retired numbers cannot be reused.',
      inputSchema: { number: z.number().int().positive(), title: z.string(), body: z.string() },
    },
    async ({ number, title, body }) => text(addDoctrineRule(number, title, body)),
  )

  server.registerTool(
    'retire_port_doctrine_rule',
    {
      description: 'Retire a doctrine rule without freeing its stable number.',
      inputSchema: { number: z.number().int().positive() },
    },
    async ({ number }) => text({ retired: retireDoctrineRule(number) }),
  )

  server.registerTool(
    'file_issue',
    {
      description: `File an actionable defect or suggestion against ${PLATFORM_SLUG} through hub, returning likely duplicate tasks.`,
      inputSchema: z.object({
        kind: z.enum(['defect', 'suggestion']).describe('How the filed issue should be read.'),
        title: z
          .string()
          .optional()
          .describe(
            'Preferred task title. Whitespace is normalized and titles over 200 characters are shortened; the response reports truncation.',
          ),
        what_happened: requiredReportField(
          'what_happened',
          'state the observed behavior or proposed change',
        ),
        expected: requiredReportField(
          'expected',
          'state what should have happened or what the suggestion should achieve',
        ),
        reproduce_command: requiredReportField(
          'reproduce_command',
          CONDITIONAL_ISSUE_REPORT_FIELD_REASONS.reproduce_command,
        ).optional(),
        environment: requiredReportField(
          'environment',
          CONDITIONAL_ISSUE_REPORT_FIELD_REASONS.environment,
        ).optional(),
        evidence: requiredReportField(
          'evidence',
          'provide concrete run ids, file:line pointers, or measured output',
        ),
        not_established: requiredReportField(
          'not_established',
          'state what remains uncertain or has not been demonstrated',
        ),
        ...reporterFields,
      }),
    },
    async (input) => {
      const missing = missingIssueReportFields(input)
      if (missing.length)
        throw new Error(
          missing
            .map(
              (field) => `${field} is required: ${CONDITIONAL_ISSUE_REPORT_FIELD_REASONS[field]}`,
            )
            .join('; '),
        )
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
      const {
        reporter_kind: _kind,
        monitor_invocation_id: _id,
        affected_project: _project,
        reporting_project: _reportingProject,
        ...issue
      } = input
      const reporter: IssueReporter =
        kind === 'monitor'
          ? {
              kind,
              invocationId: input.monitor_invocation_id!,
              affectedProject: input.affected_project!,
            }
          : { kind }
      return text(await fileIssue(issue as FileIssueInput, reporter, input.reporting_project))
    },
  )

  server.registerTool(
    'note',
    {
      description:
        'File one cwd-bound suggestion-box note. If duplicate candidates are returned, retry with same_as or new.',
      inputSchema: {
        text: z.string().trim().min(1),
        same_as: z.number().int().positive().optional(),
        new: z.boolean().optional(),
      },
    },
    async (input) => text(await fileNote(input)),
  )

  return server
}

export async function serveDocsMcp(): Promise<void> {
  await createDocsMcpServer().connect(new StdioServerTransport())
}
