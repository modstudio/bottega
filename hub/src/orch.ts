/**
 * The orchestrator, read through its CLI.
 *
 * Never by opening `orch.db`: a database shared between two concerns is how two
 * concerns quietly become one, which is the root canon's line and the reason
 * `orch` grew `--json` flags rather than hub growing a second connection.
 */

import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { DOC_SCOPES, type DocScope, type FilingDocScope } from '../../shared/docs.ts'
import { assetPath } from '../../shared/install-root.ts'
import {
  type AnswerWaitingResult,
  AnswerWaitingResultSchema,
  ClaimedOperatorNotificationSchema,
  type FileRulingResult,
  FileRulingResultSchema,
  type HarnessHealth,
  HarnessHealthSchema,
  type OperatorWaitingItem,
  OperatorWaitingItemSchema,
  type OrchBlockers,
  OrchBlockersSchema,
  type OrchProject,
  OrchProjectListSchema,
  OrchProjectSchema,
  type OrchRun,
  type OrchRunDetail,
  OrchRunDetailSchema,
  OrchRunEnvelopeSchema,
  type OrchRunLineData,
  OrchRunSchema,
  OrchStateSchema,
  OrchUnknownRunSchema,
  type RulingListRow,
  RulingListSchema,
} from '../../shared/orch-contract.ts'
import { RELEASE_AUTONOMY_VALUES } from '../../shared/release-autonomy.ts'
import { bottegaEntryArgv } from '../../shared/self-spawn.ts'

export type {
  OperatorWaitingItem,
  OrchProject,
  OrchRun,
  OrchRunDetail,
} from '../../shared/orch-contract.ts'

import {
  DASHBOARD_CAPABILITY_PATH_ENV,
  DASHBOARD_CAPABILITY_TOKEN_ENV,
  type DashboardCapability,
} from '../../shared/dashboard-capability.ts'
import { refreshProjects } from './projects.ts'

let dashboardCapability: { dir: string; path: string; token: string } | null = null
const RUNS_DEADLINE_MS = 60_000

/** Resolve the executable for every call made by a long-lived hub process. */
export function resolveOrchExecutable(): string {
  const override = process.env.HUB_ORCH?.trim() || null
  const checkout = assetPath('bin', 'orch')
  if (override && usableExecutable(override)) return override
  if (usableExecutable(checkout)) return checkout
  const found = Bun.which('orch', { PATH: process.env.PATH })
  if (found) return found
  throw missingBinary(override, checkout)
}

function usableExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function missingBinary(override: string | null, checkout: string): Error {
  return new Error(
    `orch executable unavailable: HUB_ORCH override ${override ?? 'unset'}; ` +
      `checkout executable ${checkout}; PATH lookup found nothing. ` +
      'Set HUB_ORCH to an executable file, restore the checkout executable, or add orch to PATH.',
  )
}

/** Mint the process-local capability used only by dashboard score children. */
export function startDashboardCapability(): string {
  if (dashboardCapability) return dashboardCapability.path
  const dir = mkdtempSync(join(tmpdir(), 'hub-dashboard-'))
  chmodSync(dir, 0o700)
  const path = join(dir, 'score-capability.json')
  const token = randomUUID()
  const body: DashboardCapability = { token, pid: process.pid }
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 })
  chmodSync(path, 0o600)
  dashboardCapability = { dir, path, token }
  process.once('exit', stopDashboardCapability)
  return path
}

export function stopDashboardCapability(): void {
  if (!dashboardCapability) return
  rmSync(dashboardCapability.dir, { recursive: true, force: true })
  dashboardCapability = null
}

export function dashboardMutationAvailable(): boolean {
  return dashboardCapability !== null
}

function dashboardCapabilityEnvironment(): Record<string, string> {
  return dashboardCapability
    ? {
        [DASHBOARD_CAPABILITY_PATH_ENV]: dashboardCapability.path,
        [DASHBOARD_CAPABILITY_TOKEN_ENV]: dashboardCapability.token,
      }
    : {}
}

function requiredDashboardCapabilityEnvironment(): Record<string, string> {
  if (!dashboardCapability) {
    throw new Error('dashboard mutation capability is unavailable')
  }
  return dashboardCapabilityEnvironment()
}

async function orchProcess(
  args: string[],
  timeoutMs = 20_000,
  opts: {
    stdin?: string
    env?: Record<string, string>
    acceptedExitCodes?: number[]
    acceptedOutput?: (output: string) => boolean
  } = {},
): Promise<string> {
  const command = bottegaEntryArgv('orch', resolveOrchExecutable)
  const proc = Bun.spawn([...command, ...args], {
    env: { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : 'ignore',
  })
  let killedAtDeadline = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          killedAtDeadline = true
          proc.kill()
        }, timeoutMs)
      : null
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (killedAtDeadline)
      throw new Error(
        `hub killed orch ${args.join(' ')} after its ${timeoutMs / 1_000} second deadline`,
      )
    if (code !== 0) {
      const accepted =
        opts.acceptedExitCodes?.includes(code) &&
        (opts.acceptedOutput === undefined || opts.acceptedOutput(out.trim()))
      if (!accepted) throw new Error(err.trim() || out.trim() || `orch ${args[0]} exited ${code}`)
    }
    return out.trim()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function json<T>(
  args: string[],
  schema: { parse(value: unknown): T },
  opts: {
    stdin?: string
    env?: Record<string, string>
    acceptedExitCodes?: number[]
    acceptedOutput?: (output: string) => boolean
  } = {},
): Promise<T> {
  const out = await orchProcess(args, 20_000, opts)
  let value: unknown
  try {
    value = JSON.parse(out)
  } catch {
    throw new Error(`orch ${args.slice(0, 2).join(' ')} returned invalid JSON`)
  }
  return schema.parse(value)
}

async function jsonDocument<T>(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<T> {
  const out = await orchProcess(args, 20_000, opts)
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`orch ${args.slice(0, 2).join(' ')} returned invalid JSON`)
  }
}

export function decodeRunsJson(text: string): OrchRunLineData[] {
  const rows: OrchRunLineData[] = []
  for (const [index, source] of text.split('\n').entries()) {
    const line = source.trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`orch runs --json line ${index + 1} is not JSON`)
    }
    const record =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
    const enveloped = Boolean(
      record && ('schema_version' in record || 'kind' in record || 'data' in record),
    )
    const candidate = enveloped && record ? record.data : value
    const candidateRecord =
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : null
    const dataSchema = candidateRecord?.unknown === true ? OrchUnknownRunSchema : OrchRunSchema
    const decoded = enveloped ? OrchRunEnvelopeSchema.safeParse(value) : dataSchema.safeParse(value)
    if (decoded.success) {
      rows.push(
        enveloped
          ? (decoded.data as { data: OrchRunLineData }).data
          : (decoded.data as OrchRunLineData),
      )
      continue
    }
    const dataFailure = dataSchema.safeParse(candidate)
    const issue = dataFailure.success ? decoded.error.issues[0] : dataFailure.error.issues[0]
    let path = ''
    for (const part of issue?.path ?? []) {
      path += typeof part === 'number' ? `[${part}]` : `${path ? '.' : ''}${String(part)}`
    }
    if (!path) path = 'record'
    throw new Error(`orch runs --json line ${index + 1} missing ${path}`)
  }
  return rows
}

export async function readRuns(since: string): Promise<OrchRun[]> {
  const rows = decodeRunsJson(
    await orchProcess(['runs', '--json', '--since', since], RUNS_DEADLINE_MS),
  )
  return rows.filter((row): row is OrchRun => !('unknown' in row))
}

export const readWorkflowRulings = (since: string): Promise<RulingListRow[]> =>
  json(['ruling', 'list', '--json', '--kind', 'workflow', '--since', since], RulingListSchema)

export async function readRunsById(ids: number[]): Promise<OrchRunLineData[]> {
  if (!ids.length) return []
  return decodeRunsJson(
    await orchProcess(
      ['runs', '--json', ...ids.flatMap((id) => ['--id', String(id)])],
      RUNS_DEADLINE_MS,
    ),
  )
}

export const waiting = (): Promise<OperatorWaitingItem[]> =>
  json(['waiting', '--json'], z.array(OperatorWaitingItemSchema))

export const claimWaitingNotifications = () =>
  json(['waiting', '--claim-notifications', '--json'], z.array(ClaimedOperatorNotificationSchema))

export type WaitingRuling = { questionId: number; ruling: string }

export const answerWaitingArgv = (runId: number, rulings: readonly WaitingRuling[]): string[] => [
  'answer',
  String(runId),
  ...rulings.flatMap(({ questionId, ruling }) => [`--q${questionId}`, ruling]),
  '--from-operator',
  '--channel',
  'ui',
  '--json',
]

export async function answerWaiting(
  runId: number,
  rulings: readonly WaitingRuling[],
): Promise<AnswerWaitingResult> {
  return json(answerWaitingArgv(runId, rulings), AnswerWaitingResultSchema, {
    env: dashboardCapabilityEnvironment(),
  })
}

export type FileWaitingRuling = {
  questionId: number
  as: 'doc' | 'canon'
  scope?: FilingDocScope
  subject?: string
  title?: string
}

export const fileRulingArgv = (input: FileWaitingRuling): string[] => [
  'ruling',
  'file',
  String(input.questionId),
  '--as',
  input.as,
  ...(input.scope ? ['--scope', input.scope] : []),
  ...(input.subject ? ['--subject', input.subject] : []),
  ...(input.title ? ['--title', input.title] : []),
  '--from-operator',
  '--channel',
  'ui',
  '--json',
]

export async function fileWaitingRuling(input: FileWaitingRuling): Promise<FileRulingResult> {
  return json(fileRulingArgv(input), FileRulingResultSchema, {
    env: dashboardCapabilityEnvironment(),
  })
}

export const blockers = (days: number): Promise<OrchBlockers> =>
  json(['blockers', '--days', String(days), '--json'], OrchBlockersSchema)

export function projectList(): OrchProject[] {
  const command = bottegaEntryArgv('orch', resolveOrchExecutable)
  const proc = Bun.spawnSync([...command, 'project', 'list', '--json'], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  })
  const out = proc.stdout.toString()
  const err = proc.stderr.toString().trim()
  if (proc.exitCode !== 0)
    throw new Error(err || out.trim() || `orch project exited ${proc.exitCode}`)
  try {
    return OrchProjectListSchema.parse(JSON.parse(out))
  } catch (cause) {
    throw new Error(`invalid project register: ${String(cause)}`)
  }
}

export type ProjectWriteBody = {
  path?: string
  stack?: string
  canon?: boolean
  settings?: Record<string, unknown>
}

export type ProjectAddBody = ProjectWriteBody & { path: string; name?: string }

export function projectArgv(
  op: 'add' | 'set' | 'remove',
  name: string | undefined,
  body: ProjectWriteBody = {},
): string[] {
  if (op === 'remove') return ['project', 'remove', name!]
  const args = ['project', op]
  if (op === 'add') args.push(body.path!)
  else args.push(name!)
  if (op === 'add' && name) args.push('--name', name)
  if (op === 'set' && body.path !== undefined) args.push('--path', body.path)
  if (body.stack !== undefined) args.push('--stack', body.stack)
  if (body.canon !== undefined) args.push(body.canon ? '--canon' : '--no-canon')
  if (op === 'set' && body.settings !== undefined) {
    args.push('--settings', JSON.stringify(body.settings))
  }
  args.push('--json')
  return args
}

export async function projectAdd(body: ProjectAddBody): Promise<OrchProject> {
  const result = await json(projectArgv('add', body.name, body), OrchProjectSchema)
  refreshProjects()
  return result
}

export async function projectSet(name: string, body: ProjectWriteBody): Promise<OrchProject> {
  const result = await json(projectArgv('set', name, body), OrchProjectSchema)
  refreshProjects()
  return result
}

export async function projectRemove(name: string): Promise<void> {
  await orchProcess(projectArgv('remove', name))
  refreshProjects()
}

type BranchPruneResult = {
  project: string
  key: string
  dryRun: boolean
  deleted: string[]
  wouldDelete: string[]
  kept: { branch: string; reason: string }[]
  operator: {
    branch: string
    state: 'unlanded' | 'unknown'
    commitsNotOnTrunk: number
    command: string
  }[]
  errors: string[]
}

/** Ask orchestrator to prune a closed task's run-minted branches. */
export const pruneTaskBranches = (project: string, key: string): Promise<BranchPruneResult> =>
  jsonDocument<BranchPruneResult>([
    'branches',
    'prune',
    '--project',
    project,
    '--key',
    key,
    '--json',
  ])

export const state = (days: number | null) =>
  json(['state', ...(days ? ['--days', String(days)] : [])], OrchStateSchema)

export const health = (days: number): Promise<HarnessHealth> =>
  json(['health', '--days', String(days), '--json'], HarnessHealthSchema)

export type OrchJob = {
  name: string
  what: string
  needs: Record<string, boolean>
  prefer: string[]
  contextTokens: number
  timeoutMs: number | null
  findings: boolean
}

export type OrchAgentDefinition = {
  name: string
  caps: Record<string, boolean>
  model: string
  operatedBy: 'vendor' | 'self'
  contextTokens: number | null
  maxPromptBytes: number | null
  timeoutMs: number
}

export const jobs = () => jsonDocument<OrchJob[]>(['jobs', '--json'])
export const agents = () => jsonDocument<OrchAgentDefinition[]>(['agents', '--json'])

/** Dispatch a curator like any other read-only run; its output remains the run record. */
export const dispatchNoteCurator = (cwd: string, prompt: string): Promise<string> =>
  orchProcess(['do', 'understand', '--cwd', cwd], 0, { stdin: prompt })

export const run = (id: number): Promise<OrchRunDetail> =>
  json(['run', String(id)], OrchRunDetailSchema)
export const runDetail = run

/**
 * Score a run as a person, from the dashboard.
 *
 * The process capability is the session gate's one exception: the gate exists
 * so an agent cannot judge a run it never read, while someone clicking a
 * verdict has the output in front of them. `--scorer` records who judged it;
 * the independently checked capability proves where the call came from.
 */
export async function score(
  id: number,
  delivery: string,
  quality: string | null,
  fidelity: string | null,
  note: string | null,
) {
  const args = [
    'score',
    String(id),
    delivery,
    ...(quality ? [quality] : []),
    ...(fidelity ? [fidelity] : []),
    '--scorer',
    'hub-dashboard',
    ...(note ? ['--note', note] : []),
  ]
  return orchProcess(args, 20_000, { env: requiredDashboardCapabilityEnvironment() })
}

export type { DocScope }

export type DocRow = {
  id: number
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  revision: string | null
  created_at: string
  updated_at: string
}

const DocRowSchema = z.object({
  id: z.number(),
  scope: z.enum(DOC_SCOPES),
  subject: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  delivery: z.enum(['inject', 'demand']),
  revision: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const ConfigEntrySchema = z.object({
  key: z.string(),
  environment: z.string(),
  scope: z.enum(['user', 'space']),
  value: z.string(),
  rowVersion: z.number(),
  updatedAt: z.string(),
})

const ContextSchema = z.discriminatedUnion('registered', [
  z.object({ registered: z.literal(false), warnings: z.array(z.string()).optional() }),
  z.object({
    registered: z.literal(true),
    project: z.string(),
    rulings: z.object({ value: z.enum(['agent', 'user']), scope: z.string() }),
    release: z.object({
      value: z.enum(RELEASE_AUTONOMY_VALUES),
      scope: z.string(),
      landing: z.string().nullable(),
      production: z.string().nullable(),
    }),
    stages: z.array(
      z.union([
        z.object({
          stage: z.enum(['plan', 'implement', 'review', 'docs', 'canon', 'ship']),
          agreed: z.literal(true),
          value: z.enum(['ask', 'review', 'auto']),
          scope: z.string(),
          steps: z.number(),
        }),
        z.object({
          stage: z.enum(['plan', 'implement', 'review', 'docs', 'canon', 'ship']),
          agreed: z.literal(false),
          values: z.array(
            z.object({
              value: z.enum(['ask', 'review', 'auto']),
              scope: z.string(),
              steps: z.number(),
            }),
          ),
        }),
      ]),
    ),
    text: z.string(),
    warnings: z.array(z.string()).optional(),
  }),
])

const HookSummarySchema = z.object({
  event: z.string(),
  matcher: z.string(),
  fingerprint: z.string(),
})
const SettingsCheckSchema = z.object({
  target: z.union([
    z.object({ kind: z.literal('user') }),
    z.object({ kind: z.literal('project'), name: z.string() }),
  ]),
  file: z.object({ path: z.string(), exists: z.boolean() }),
  revision: z.string().nullable(),
  settings: z.object({
    permissions: z.object({
      allow: z.array(z.string()),
      ask: z.array(z.string()),
      deny: z.array(z.string()),
    }),
    hooks: z.array(HookSummarySchema),
    envKeys: z.array(z.string()),
  }),
  drift: z.object({
    rules: z.object({
      allow: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
      ask: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
      deny: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
    }),
    hooks: z.object({ added: z.array(HookSummarySchema), removed: z.array(HookSummarySchema) }),
    envKeys: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  }),
  findings: z.array(
    z.object({ file: z.string(), line: z.number(), rule: z.string(), message: z.string() }),
  ),
})

export const contextArgv = (cwd: string) => ['context', '--cwd', cwd, '--json']
export const configArgv = (
  op: 'get' | 'list' | 'set',
  key?: string,
  value?: string,
  expectedRowVersion?: number | null,
) => [
  'config',
  op,
  ...(key ? [key] : []),
  ...(value ? [value] : []),
  ...(expectedRowVersion !== undefined ? ['--expect', String(expectedRowVersion)] : []),
  '--json',
]
export const configDeleteArgv = (key: string, expectedRowVersion?: number) => [
  'config',
  'delete',
  key,
  ...(expectedRowVersion !== undefined ? ['--expect', String(expectedRowVersion)] : []),
]
export const settingsCheckArgv = (target: { user: true } | { project: string }) => [
  'settings',
  'render',
  '--check',
  ...('user' in target ? ['--user'] : ['--project', target.project]),
  '--json',
]

export const settingsPermissionArgv = (input: SettingsPermissionInput) => [
  'settings',
  'permission',
  input.operation,
  ...('user' in input.target ? ['--user'] : ['--project', input.target.project]),
  '--list',
  input.list,
  '--rule',
  input.rule,
  '--expect',
  input.expectedRevision,
  ...(input.reason ? ['--reason', input.reason] : []),
  '--json',
]

export const userDocList = () =>
  json(docArgv('list', { scope: 'canon', user: true }), z.array(DocRowSchema)) as Promise<DocRow[]>
export const userDocGet = (slug: string, scope = 'canon') =>
  json(docArgv('get', { slug, scope, user: true }), DocRowSchema) as Promise<DocRow>
export const userDocSet = (input: Omit<DocSetInput, 'scope' | 'subject'>, scope = 'canon') =>
  json(docArgv('set', { ...input, scope, user: true }), DocRowSchema, {
    stdin: input.body,
    env: requiredDashboardCapabilityEnvironment(),
  }) as Promise<DocRow>
export const userDocRemove = (slug: string, reason: string, expectedRevision?: string) =>
  json(
    docArgv('remove', { slug, scope: 'canon', user: true, reason, expectedRevision }),
    z.object({ removed: z.boolean() }),
    { env: requiredDashboardCapabilityEnvironment() },
  )

export const contextGet = (cwd: string) => json(contextArgv(cwd), ContextSchema)
export const configSet = (key: string, value: string, expectedRowVersion?: number | null) =>
  json(configArgv('set', key, value, expectedRowVersion), ConfigEntrySchema, {
    env: requiredDashboardCapabilityEnvironment(),
  })
export const configList = () => json(configArgv('list'), z.array(ConfigEntrySchema))
export const configDelete = (key: string, expectedRowVersion?: number) =>
  orchProcess(configDeleteArgv(key, expectedRowVersion), 20_000, {
    env: requiredDashboardCapabilityEnvironment(),
  })
export const settingsCheck = (target: { user: true } | { project: string }) =>
  json(settingsCheckArgv(target), SettingsCheckSchema, {
    acceptedExitCodes: [1],
    acceptedOutput: (output) => {
      try {
        return SettingsCheckSchema.safeParse(JSON.parse(output)).success
      } catch {
        return false
      }
    },
  })

const SettingsPermissionResultSchema = z.object({
  revision: z.string(),
  counts: z.object({ allow: z.number(), ask: z.number(), deny: z.number() }),
  changed: z.boolean(),
  message: z.string().optional(),
})

export type SettingsPermissionInput = {
  target: { user: true } | { project: string }
  operation: 'add' | 'remove'
  list: 'allow' | 'ask' | 'deny'
  rule: string
  expectedRevision: string
  reason?: string
}

export const settingsPermission = (input: SettingsPermissionInput) =>
  json(settingsPermissionArgv(input), SettingsPermissionResultSchema, {
    env: requiredDashboardCapabilityEnvironment(),
  })

export type DocSubjects = {
  project: string[]
  stack: string[]
  agent: string[]
  job: string[]
}

export type DocListFilters = {
  scope?: string
  subject?: string | null
}

export type DocSetInput = {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  reason: string
  delivery?: 'inject' | 'demand'
  expectedRevision?: string
}

export type DocRevisionMetadata = {
  id: number
  op: 'create' | 'set' | 'consume' | 'delete' | 'restore' | 'import' | 'backfill'
  author: string
  reason: string
  at: string
  bytes: number
}

export type DocArgvInput = {
  scope?: string
  subject?: string | null
  slug?: string
  title?: string
  body?: string
  reason?: string
  delivery?: 'inject' | 'demand'
  expectedRevision?: string
  user?: boolean
}

export type DocOp = 'list' | 'get' | 'set' | 'remove' | 'history' | 'subjects'

function subjectFlags(subject: string | null | undefined): string[] {
  return subject ? ['--subject', subject] : []
}

function docAddressFlags(input: DocArgvInput): string[] {
  return [
    ...(input.scope ? ['--scope', input.scope] : []),
    ...(input.user ? ['--user'] : subjectFlags(input.subject)),
  ]
}

export function docArgv(op: DocOp, input: DocArgvInput = {}): string[] {
  switch (op) {
    case 'list':
      return ['doc', 'list', ...docAddressFlags(input), '--json']
    case 'get':
      return ['doc', 'show', input.slug!, ...docAddressFlags(input), '--json']
    case 'set':
      return [
        'doc',
        'set',
        input.slug!,
        ...docAddressFlags(input),
        '--title',
        input.title!,
        '--reason',
        input.reason!,
        '--author',
        'hub-dashboard',
        ...(input.delivery ? ['--delivery', input.delivery] : []),
        ...(input.expectedRevision ? ['--expect', input.expectedRevision] : []),
        '--json',
      ]
    case 'remove':
      return [
        'doc',
        'rm',
        input.slug!,
        ...docAddressFlags(input),
        '--reason',
        input.reason!,
        '--author',
        'hub-dashboard',
        ...(input.expectedRevision ? ['--expect', input.expectedRevision] : []),
        '--json',
      ]
    case 'history':
      return ['doc', 'history', input.scope!, input.subject ?? '-', input.slug!, '--json']
    case 'subjects':
      return ['doc', 'subjects', '--json']
  }
}

export const docList = (filters: DocListFilters = {}) =>
  jsonDocument<DocRow[]>(docArgv('list', filters))

export const docGet = (scope: string, subject: string | null, slug: string) =>
  jsonDocument<DocRow>(docArgv('get', { scope, subject, slug }))

export const docSet = (input: DocSetInput) =>
  jsonDocument<DocRow>(docArgv('set', input), { stdin: input.body })

export const docRemove = (
  scope: string,
  subject: string | null,
  slug: string,
  reason: string,
  expectedRevision?: string,
) =>
  jsonDocument<{ removed: boolean }>(
    docArgv('remove', { scope, subject, slug, reason, expectedRevision }),
  )

export const docHistory = (scope: string, subject: string | null, slug: string) =>
  jsonDocument<DocRevisionMetadata[]>(docArgv('history', { scope, subject, slug }))

export const docSubjects = () => jsonDocument<DocSubjects>(docArgv('subjects'))
