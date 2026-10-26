import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { MCP_SERVER_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { db, enableSchemaReload, sessionId } from '../database/db.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { registerStandardRuntime } from '../runtime/runtime-registration.ts'

registerStandardRuntime()

import { strictlyAuthenticatedWorkerRun } from '../ask/worker-auth.ts'
import { collectCanonLintInput } from '../canon/canon-files.ts'
import { selectDocWriteTree } from '../doc/doc-write-tree.ts'
import { docsMarkdown, listDocs } from '../doc/docs.ts'
import { validatedTrackerTaskKey } from '../issue/issue.ts'
import { filedIssueDataLine } from '../issue/issue-file.ts'
import {
  CONDITIONAL_ISSUE_REPORT_FIELD_REASONS,
  missingIssueReportFields,
} from '../issue/issue-report-fields.ts'
import { resolveLens } from '../lens/lenses.ts'
import {
  addDoctrineRule,
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
  setBaselineForProjects,
  setLedgerRef,
} from '../porting/porting.ts'
import { type Project, projectAt, projectByName, projects } from '../project/projects.ts'
import { getReview, listReviews } from '../review/review.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { catalogueStepsForAutonomy, parseAutonomy } from '../workflow/autonomy.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import {
  type CommitCountPort,
  type LandingBranchPorts,
  workflowComposeBranchRefusal,
} from '../workflow/workflow-compose-branch.ts'
import {
  abandonWorkflowCursorByHandle,
  awaitWorkflowRuling,
  ruleWorkflow,
} from '../workflow/workflow-cursor.ts'
import {
  mcpWorkflowCursorContext,
  resolveWorkflowCursorContext,
  resolveWorkflowCursorMode,
} from '../workflow/workflow-cursor-selection.ts'
import {
  attachWorkflowTextByHandle,
  WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES,
} from '../workflow/workflow-text.ts'
import { composeWorkflow, listResolvedWorkflows } from '../workflow/workflows.ts'
import type { HubTaskReader } from '../workflow/workflow-task-reference.ts'
import { fileNote, hubOutput } from './hub-notes.ts'
import { registerBoardTools } from './mcp-board-tools.ts'
import { registerDocTools } from './mcp-doc-tools.ts'
import { registerOperatorTools } from './mcp-operator-tools.ts'
import { registerWorkflowPrompts } from './mcp-prompts.ts'
import { registerSearchTools } from './mcp-search-tools.ts'
import { registerSetupTools } from './mcp-setup-tools.ts'
import { registerSubjectTools } from './mcp-subject-tools.ts'
import { advanceWorkflow } from './mcp-workflow-advance.ts'
import { nextWorkflowStepInputSchema } from './mcp-workflow-input.ts'
import { resolveMcpWorkflowSpace } from './mcp-workflow-space.ts'
import { registerWorkflowStepTool } from './mcp-workflow-step.ts'

type DocsMcpPorts = LandingBranchPorts & {
  hubTaskReader?: HubTaskReader
}

const portLedgerSources = (
  sources: Array<{ project: string; commits: string[]; paths: string[]; note: string }>,
) =>
  sources.map((source) => ({
    source_project_record_id: registeredProject(source.project).recordId,
    commits: source.commits,
    paths: source.paths,
    note: source.note,
  }))

const text = (value: unknown, isError = false) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
  ...(isError ? { isError: true } : {}),
})

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
      'Omit to derive the calling session or authenticated orchestrator worker from the environment.',
    ),
  monitor_invocation_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The monitor invocation's display number."),
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
      throw new Error(`${PLATFORM_SLUG} task duplicates returned a non-array JSON value`)
    return { duplicates, error: null }
  } catch (error) {
    return { duplicates: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export type IssueReporter =
  | { kind: 'session' }
  | { kind: 'monitor'; invocationId: number; affectedProject: string }

export function fileIssueTaskKey(stdout: string, project: Project): string {
  return validatedTrackerTaskKey(stdout.trim(), project, `${PLATFORM_SLUG} task new for file_issue`)
}

type WorkerReporter = {
  record_id: string
  job: string
  agent: string
  launch_cwd: string | null
  launch_key: string | null
}

const workerReporter = (runId: string) =>
  db()
    .query('SELECT record_id, job, agent, launch_cwd, launch_key FROM run WHERE record_id=?')
    .get(runId) as WorkerReporter | null

function registeredProject(name: string) {
  const project = projectByName(name)
  if (!project) throw new Error(`unknown project "${name}"`)
  return project
}

function registeredPair(source: string, target: string) {
  const sourceProject = registeredProject(source)
  const targetProject = registeredProject(target)
  if (sourceProject.recordId === targetProject.recordId) {
    throw new Error('a port source and target must be different projects')
  }
  const pair = pairByProjects(sourceProject.recordId, targetProject.recordId) ?? null
  return { sourceProject, targetProject, pair }
}

async function setNamedPortBaseline(source: string, target: string, commit: string | null) {
  const { sourceProject, targetProject } = registeredPair(source, target)
  return setBaselineForProjects(sourceProject.recordId, targetProject.recordId, commit)
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
  if (reporter.kind !== 'session' && reporter.kind !== 'monitor')
    throw new Error('unknown issue reporter kind')
  const session = reporter.kind === 'session' ? sessionId() : null
  let worker: WorkerReporter | null = null
  let reporterId: string | number = session ?? ''
  if (reporter.kind === 'session' && !session) {
    const runId = resolveRunIdentifier(db(), process.env.BOTTEGA_RUN_ID ?? '')
    const token = process.env.BOTTEGA_RUN_TOKEN ?? ''
    if (!strictlyAuthenticatedWorkerRun(runId, token)) {
      throw new Error('cannot file issue: the reporting session is not available')
    }
    worker = workerReporter(runId)
    if (!worker?.launch_cwd) {
      throw new Error('cannot file issue: the reporting worker has no project origin')
    }
    reporterId = `run:${worker.record_id}`
  } else if (reporter.kind === 'monitor') {
    const invocation = db()
      .query('SELECT record_id FROM monitor_invocation WHERE number=?')
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
  const platformProject = registeredProject(PLATFORM_SLUG)
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
          `Filed by orchestrator run ${worker.record_id} (${worker.job}, ${worker.agent}) while working ${
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
    key: fileIssueTaskKey(stdout, platformProject),
    kind: input.kind,
    session,
    project: project.name,
    title,
    title_shortened: titleShortened,
    reporter: worker ? 'worker' : reporter.kind,
    reporter_id: reporterId,
    worker_run_record_id: worker?.record_id ?? null,
    ...(worker ? { origin: worker.launch_key } : {}),
    monitor_invocation_id: reporter.kind === 'monitor' ? reporter.invocationId : null,
    ...(duplicateSearch.duplicates === null
      ? { duplicate_search_error: duplicateSearch.error }
      : { duplicates: duplicateSearch.duplicates }),
  }
}

/** Composes a workflow for the MCP caller, refusing one whose branch carries nothing to land. */
async function composeWorkflowToolResult(
  input: {
    slug: string
    project: string
    mode?: string
    args?: Record<string, string>
    version?: number
    catalogue_version?: number
    autonomy?: string
  },
  commitCount?: CommitCountPort,
) {
  const refusal = workflowComposeBranchRefusal({
    workflow: input.slug,
    project: input.project,
    args: input.args ?? {},
    ...(commitCount ? { commitCount } : {}),
  })
  if (refusal) throw new Error(refusal)
  const selection = { version: input.version, catalogueVersion: input.catalogue_version }
  const args = input.args ?? {}
  const preliminary = composeWorkflow(
    input.slug,
    input.project,
    input.mode,
    args,
    undefined,
    selection,
  )
  const resolved = await resolveProjectAutonomy(
    input.project,
    preliminary.workflow.slug,
    preliminary.workflow.defaultPreset,
    catalogueStepsForAutonomy(preliminary.steps),
    parseAutonomy(input.autonomy, 'session'),
  )
  return composeWorkflow(
    input.slug,
    input.project,
    input.mode,
    args,
    undefined,
    selection,
    resolved,
  )
}

/**
 * Registers the workflow identity listing, which hides retired rows unless the caller asks for
 * them with `retired`.
 */
function registerWorkflowListTool(server: McpServer): void {
  server.registerTool(
    'list_workflows',
    {
      description: 'List workflow identities and their production and draft versions.',
      inputSchema: z.object({
        retired: z
          .boolean()
          .optional()
          .describe('include workflows whose only versions are retired'),
      }),
    },
    async ({ retired }) =>
      text(
        listResolvedWorkflows(
          resolveMcpWorkflowSpace(process.cwd()).spaceId,
          undefined,
          retired ?? false,
        ),
      ),
  )
}

export function createDocsMcpServer(ports: DocsMcpPorts = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' })
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

  registerWorkflowPrompts(server, ports.hubTaskReader)
  registerSearchTools(server)
  registerOperatorTools(server)
  registerBoardTools(server)
  registerSetupTools(server)
  registerWorkflowListTool(server)

  server.registerTool(
    'compose_workflow',
    {
      description:
        'Purely compose a workflow index without opening a run or returning step bodies. Fetch step 1 with get_workflow_step to open the run.',
      inputSchema: z.object({
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
        version: z.number().int().positive().optional(),
        catalogue_version: z.number().int().positive().optional(),
        autonomy: z.string().optional(),
      }),
    },
    async (input) => text(await composeWorkflowToolResult(input, ports.commitCount)),
  )

  registerWorkflowStepTool(server, ports.commitCount, ports.hubTaskReader)

  server.registerTool(
    'attach_workflow_text',
    {
      description:
        'Attach cursor-local working text to the current workflow step and return its evidence reference.',
      inputSchema: z.object({
        cursor: z.number().int().positive(),
        text: z.string().min(1).max(WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES),
      }),
    },
    async ({ cursor, text: body }) =>
      text(attachWorkflowTextByHandle(cursor, body, mcpWorkflowCursorContext())),
  )

  server.registerTool(
    'next_workflow_step',
    {
      description:
        'Close the current step with a one-line note and a validated evidence reference for its floor, then fetch the next; the cursor is the record.',
      inputSchema: nextWorkflowStepInputSchema,
    },
    (input) => advanceWorkflow(input, ports.hubTaskReader),
  )

  server.registerTool(
    'await_workflow_ruling',
    {
      description: 'Record that the workflow is paused on a question for the operator.',
      inputSchema: z.object({
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
        question: z.string().trim().min(1),
        cursor: z.number().int().positive().optional(),
      }),
    },
    async ({ slug, project, mode, args, question, cursor }) => {
      const workflowArgs = args ?? {}
      const context = await resolveWorkflowCursorContext(
        project,
        workflowArgs,
        mcpWorkflowCursorContext(),
        ports.hubTaskReader,
      )
      const effectiveMode = resolveWorkflowCursorMode(
        slug,
        project,
        mode,
        workflowArgs,
        context,
        'await_workflow_ruling',
        'pass the mode argument',
        undefined,
        cursor,
      )
      return text(
        awaitWorkflowRuling(
          slug,
          project,
          effectiveMode,
          workflowArgs,
          question,
          context,
          undefined,
          undefined,
          cursor,
        ),
      )
    },
  )

  server.registerTool(
    'rule_workflow',
    {
      description: 'Record a ruling and resume the workflow on the same step.',
      inputSchema: z.object({
        slug: z.string().trim().min(1),
        project: z.string().trim().min(1),
        mode: z.string().trim().min(1).optional(),
        args: z.record(z.string(), z.string()).optional(),
        ruling: z.string().trim().min(1),
        from_operator: z.boolean().optional(),
        cursor: z.number().int().positive().optional(),
      }),
    },
    async ({ slug, project, mode, args, ruling, from_operator, cursor }) => {
      const workflowArgs = args ?? {}
      const context = await resolveWorkflowCursorContext(
        project,
        workflowArgs,
        mcpWorkflowCursorContext(),
        ports.hubTaskReader,
      )
      return text(
        ruleWorkflow(
          slug,
          project,
          resolveWorkflowCursorMode(
            slug,
            project,
            mode,
            workflowArgs,
            context,
            'rule_workflow',
            'pass the mode argument',
            undefined,
            cursor,
          ),
          workflowArgs,
          ruling,
          Boolean(from_operator),
          'mcp',
          context,
          undefined,
          cursor,
        ),
      )
    },
  )

  server.registerTool(
    'abandon_workflow',
    {
      description: 'Abandon one workflow run by cursor handle.',
      inputSchema: z.object({
        cursor: z.number().int().positive(),
        reason: z.string().trim().min(1),
      }),
    },
    async ({ cursor, reason }) =>
      text(abandonWorkflowCursorByHandle(cursor, reason, mcpWorkflowCursorContext())),
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
      inputSchema: z.object({ id: z.string().trim().min(1), project: z.string().trim().min(1) }),
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
      inputSchema: z.object({
        open: z.boolean().optional(),
        complete: z.boolean().optional(),
        project: z.string().trim().min(1).optional(),
        since: z.iso.datetime().optional(),
      }),
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
      inputSchema: z.object({ id: z.union([z.number().int().positive(), z.uuid()]) }),
    },
    async ({ id }) => text(getReview(resolveReviewIdentifier(db(), id))),
  )

  server.registerTool(
    'project_brief',
    {
      description: 'Get a registered project row and its operator documents.',
      inputSchema: z.object({ name: z.string() }),
    },
    async ({ name }) => {
      const project = projectByName(name)
      if (!project) throw new Error(`unknown project "${name}"`)
      const markdown = docsMarkdown(
        listDocs({ scope: 'project', subject: name, status: 'current' }),
      )
      return text(`${JSON.stringify(project)}${markdown ? `\n\n${markdown}` : ''}`)
    },
  )

  registerDocTools(server, { selectDocWriteTree, collectCanonLintInput })
  registerSubjectTools(server)

  server.registerTool(
    'inspect_port_baseline',
    {
      description: 'Inspect scan progress for one registered source-to-target project pair.',
      inputSchema: z.object({ source: z.string(), target: z.string() }),
    },
    async ({ source, target }) => {
      const { pair } = registeredPair(source, target)
      return text(pair ? { pair, baseline: baselineForPair(pair.record_id) } : null)
    },
  )

  server.registerTool(
    'set_port_baseline',
    {
      description: 'Set or clear scan progress for one registered source-to-target project pair.',
      inputSchema: z.object({
        source: z.string(),
        target: z.string(),
        source_commit: z.string().nullable(),
      }),
    },
    async ({ source, target, source_commit }) =>
      text(await setNamedPortBaseline(source, target, source_commit)),
  )

  server.registerTool(
    'list_port_skips',
    {
      description: 'List declined candidates and reasons for a registered project pair.',
      inputSchema: z.object({ source: z.string(), target: z.string() }),
    },
    async ({ source, target }) => {
      const { pair } = registeredPair(source, target)
      return text(pair ? listSkips(pair.record_id) : [])
    },
  )

  server.registerTool(
    'record_port_skip',
    {
      description: 'Record a declined candidate and its reason for an existing project pair.',
      inputSchema: z.object({
        source: z.string(),
        target: z.string(),
        candidate: z.string(),
        reason: z.string(),
      }),
    },
    async ({ source, target, candidate, reason }) => {
      const { pair } = registeredPair(source, target)
      if (!pair)
        throw new Error(`no port pair from "${source}" to "${target}"; set its baseline first`)
      return text(await addSkip(pair.record_id, candidate, reason))
    },
  )

  server.registerTool(
    'list_port_ledger_refs',
    {
      description: 'List unresolved port ledger refs; include resolved refs only when requested.',
      inputSchema: z.object({ include_resolved: z.boolean().optional() }),
    },
    async ({ include_resolved }) => text(listLedgerRefs(include_resolved ?? false)),
  )

  server.registerTool(
    'get_port_ledger_ref',
    {
      description: 'Look up the source provenance recorded for a target task key.',
      inputSchema: z.object({ project: z.string(), task_key: z.string() }),
    },
    async ({ project, task_key }) => text(ledgerRef(registeredProject(project).recordId, task_key)),
  )

  server.registerTool(
    'set_port_ledger_ref',
    {
      description: 'Record source projects, commits, paths, and notes for a staged target task.',
      inputSchema: z.object({
        task_key: z.string(),
        project: z.string(),
        note: z.string(),
        sources: z.array(ledgerSourceSchema).min(1),
      }),
    },
    async ({ project, task_key, note, sources }) =>
      text(
        await setLedgerRef(
          {
            taskKey: task_key,
            targetProjectId: registeredProject(project).recordId,
            note,
            sources: portLedgerSources(sources),
          },
          ports.hubTaskReader,
        ),
      ),
  )

  server.registerTool(
    'resolve_port_ledger_ref',
    {
      description: 'Mark a staged target task resolved while preserving its source provenance.',
      inputSchema: z.object({ project: z.string(), task_key: z.string() }),
    },
    async ({ project, task_key }) => {
      const ref = await resolveLedgerRef(registeredProject(project).recordId, task_key)
      if (!ref) throw new Error(`no port ledger ref for task "${project}:${task_key}"`)
      return text(ref)
    },
  )

  server.registerTool(
    'delete_erroneous_port_ledger_ref',
    {
      description:
        'Correction only: permanently delete a port ledger ref that was recorded in error.',
      inputSchema: z.object({ project: z.string(), task_key: z.string() }),
    },
    async ({ project, task_key }) =>
      text({ removed: await removeLedgerRef(registeredProject(project).recordId, task_key) }),
  )

  server.registerTool(
    'list_port_doctrine',
    {
      description:
        'List active doctrine rules; include retired stable numbers only when requested.',
      inputSchema: z.object({ include_retired: z.boolean().optional() }),
    },
    async ({ include_retired }) => text(listDoctrineRules(include_retired ?? false)),
  )

  server.registerTool(
    'add_port_doctrine_rule',
    {
      description: 'Add a numbered porting doctrine rule. Retired numbers cannot be reused.',
      inputSchema: z.object({
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string(),
      }),
    },
    async ({ number, title, body }) => text(await addDoctrineRule(number, title, body)),
  )

  server.registerTool(
    'retire_port_doctrine_rule',
    {
      description: 'Retire a doctrine rule without freeing its stable number.',
      inputSchema: z.object({ number: z.number().int().positive() }),
    },
    async ({ number }) => text({ retired: await retireDoctrineRule(number) }),
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
      inputSchema: z.object({
        text: z.string().trim().min(1),
        project: z.string().trim().min(1).optional(),
        same_as: z.string().min(1).optional(),
        new: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (process.env.BOTTEGA_RUN_ID || process.env.BOTTEGA_DEPTH) {
        throw new Error(
          `Worker note filing is available only through the ${WORKER_MCP_SERVER_NAME} note tool; do not retry this ${MCP_SERVER_NAME} MCP tool.`,
        )
      }
      try {
        return text(await fileNote(input))
      } catch {
        return text('The note was not filed.', true)
      }
    },
  )

  return server
}

export async function serveDocsMcp(): Promise<void> {
  serveStdio(() => createDocsMcpServer())
}
