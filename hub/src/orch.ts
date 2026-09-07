/**
 * The orchestrator, read through its CLI.
 *
 * Never by opening `orch.db`: a database shared between two concerns is how two
 * concerns quietly become one, which is the root canon's line and the reason
 * `orch` grew `--json` flags rather than hub growing a second connection.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DocScope } from '../../shared/docs.ts'
import {
  OrchBlockersSchema, OrchProjectListSchema, OrchProjectSchema, OrchRunDetailSchema,
  OrchRunEnvelopeSchema, OrchRunSchema, OrchStateSchema, OrchUnknownRunSchema,
  type OrchBlockers, type OrchProject, type OrchRun, type OrchRunDetail,
  type OrchRunLineData,
} from '../../shared/orch-contract.ts'
export type { OrchProject, OrchRun, OrchRunDetail, OrchState } from '../../shared/orch-contract.ts'
import {
  DASHBOARD_CAPABILITY_PATH_ENV, DASHBOARD_CAPABILITY_TOKEN_ENV,
  type DashboardCapability,
} from '../../shared/dashboard-capability.ts'
import { refreshProjects } from './projects.ts'
let dashboardCapability: { dir: string; path: string; token: string } | null = null

/** Resolve the executable afresh so a server follows its checkout when it moves. */
function orchPath(): string {
  if (process.env.HUB_ORCH) return process.env.HUB_ORCH
  const root = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'ignore',
  })
  const checkout = root.exitCode === 0 ? root.stdout.toString().trim() : ''
  return resolve(checkout || new URL('../..', import.meta.url).pathname, 'bin/orch')
}

function missingBinary(path: string): Error {
  return new Error(
    `orch is not at ${path}. This server was started from a checkout that has ` +
    `since moved or been renamed; restart it from the current one.`,
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

async function orchProcess(
  args: string[],
  timeoutMs = 20_000,
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const path = orchPath()
  if (!existsSync(path)) throw missingBinary(path)
  const proc = Bun.spawn([path, ...args], {
    env: { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : 'ignore',
  })
  const timer = timeoutMs > 0 ? setTimeout(() => proc.kill(), timeoutMs) : null
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(err.trim() || out.trim() || `orch ${args[0]} exited ${code}`)
    return out.trim()
  } finally { if (timer) clearTimeout(timer) }
}

async function json<T>(args: string[], schema: { parse(value: unknown): T }, opts: { stdin?: string } = {}): Promise<T> {
  const out = await orchProcess(args, 20_000, opts)
  let value: unknown
  try { value = JSON.parse(out) }
  catch { throw new Error(`orch ${args.slice(0, 2).join(' ')} returned invalid JSON`) }
  return schema.parse(value)
}

async function jsonDocument<T>(args: string[], opts: { stdin?: string } = {}): Promise<T> {
  const out = await orchProcess(args, 20_000, opts)
  try { return JSON.parse(out) as T }
  catch { throw new Error(`orch ${args.slice(0, 2).join(' ')} returned invalid JSON`) }
}

export function decodeRunsJson(text: string): OrchRunLineData[] {
  const rows: OrchRunLineData[] = []
  for (const [index, source] of text.split('\n').entries()) {
    const line = source.trim()
    if (!line) continue
    let value: unknown
    try { value = JSON.parse(line) }
    catch { throw new Error(`orch runs --json line ${index + 1} is not JSON`) }
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
    const enveloped = Boolean(record && ('schema_version' in record || 'kind' in record || 'data' in record))
    const candidate = enveloped && record ? record.data : value
    const candidateRecord = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown> : null
    const dataSchema = candidateRecord?.unknown === true ? OrchUnknownRunSchema : OrchRunSchema
    const decoded = enveloped ? OrchRunEnvelopeSchema.safeParse(value) : dataSchema.safeParse(value)
    if (decoded.success) {
      rows.push(enveloped
        ? (decoded.data as { data: OrchRunLineData }).data
        : decoded.data as OrchRunLineData)
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
  const rows = decodeRunsJson(await orchProcess(['runs', '--json', '--since', since]))
  return rows.filter((row): row is OrchRun => !('unknown' in row))
}

export async function readRunsById(ids: number[]): Promise<OrchRunLineData[]> {
  if (!ids.length) return []
  return decodeRunsJson(await orchProcess([
    'runs', '--json', ...ids.flatMap((id) => ['--id', String(id)]),
  ]))
}

export const blockers = (days: number): Promise<OrchBlockers> =>
  json(['blockers', '--days', String(days), '--json'], OrchBlockersSchema)

export function projectList(): OrchProject[] {
  const path = orchPath()
  if (!existsSync(path)) throw missingBinary(path)
  const proc = Bun.spawnSync([path, 'project', 'list', '--json'], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  })
  const out = proc.stdout.toString()
  const err = proc.stderr.toString().trim()
  if (proc.exitCode !== 0) throw new Error(err || out.trim() || `orch project exited ${proc.exitCode}`)
  try { return OrchProjectListSchema.parse(JSON.parse(out)) }
  catch (cause) { throw new Error(`invalid project register: ${String(cause)}`) }
}

export type ProjectWriteBody = {
  path?: string
  stack?: string
  canon?: boolean
  settings?: Record<string, unknown>
}

export type ProjectAddBody = ProjectWriteBody & { path: string; name?: string }

export function projectArgv(
  op: 'add' | 'set' | 'remove', name: string | undefined, body: ProjectWriteBody = {},
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

export async function projectSet(
  name: string, body: ProjectWriteBody,
): Promise<OrchProject> {
  const result = await json(projectArgv('set', name, body), OrchProjectSchema)
  refreshProjects()
  return result
}

export async function projectRemove(name: string): Promise<void> {
  await orchProcess(projectArgv('remove', name))
  refreshProjects()
}

export type OrchAgent = {
  agent: string; billing: string; cooling: number | null
  lastStatus: string | null; lastKind: string | null; minsAgo: number | null
}

export const state = (days: number | null) =>
  json(['state', ...(days ? ['--days', String(days)] : [])], OrchStateSchema)

export type OrchHealth = {
  header: string
  days: number
  from: string
  classes: {
    kind: string; count: number; totalTimeMs: number; meanTimeMs: number
    firstSeen: string | null; lastSeen: string | null
    clusters: { text: string; count: number; exampleRunId: number }[]
    sparkline: { day: string; count: number }[]
  }[]
  falseVerdicts: { kind: string; verdicts: number; falseVerdicts: number; rate: number }[]
  landingRefusals: number
}

export const health = (days: number) => jsonDocument<OrchHealth>(['health', '--days', String(days), '--json'])

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
  contextTokens: number | null
  maxPromptBytes: number | null
  timeoutMs: number
}

export const jobs = () => jsonDocument<OrchJob[]>(['jobs', '--json'])
export const agents = () => jsonDocument<OrchAgentDefinition[]>(['agents', '--json'])

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
  id: number, delivery: string, quality: string | null, fidelity: string | null,
  note: string | null,
) {
  const args = ['score', String(id), delivery, ...(quality ? [quality] : []),
                ...(fidelity ? [fidelity] : []),
                '--scorer', 'hub-dashboard', ...(note ? ['--note', note] : [])]
  const capabilityEnv: Record<string, string> = dashboardCapability ? {
    [DASHBOARD_CAPABILITY_PATH_ENV]: dashboardCapability.path,
    [DASHBOARD_CAPABILITY_TOKEN_ENV]: dashboardCapability.token,
  } : {}
  return orchProcess(args, 20_000, { env: capabilityEnv })
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
  created_at: string
  updated_at: string
}

export type DocSubjects = {
  project: string[]
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
}

export type DocOp = 'list' | 'get' | 'set' | 'remove' | 'history' | 'subjects'

function subjectFlags(subject: string | null | undefined): string[] {
  return subject ? ['--subject', subject] : []
}

export function docArgv(op: DocOp, input: DocArgvInput = {}): string[] {
  switch (op) {
    case 'list':
      return [
        'doc', 'list',
        ...(input.scope ? ['--scope', input.scope] : []),
        ...subjectFlags(input.subject),
        '--json',
      ]
    case 'get':
      return [
        'doc', 'show', input.slug!, '--scope', input.scope!,
        ...subjectFlags(input.subject),
        '--json',
      ]
    case 'set':
      return [
        'doc', 'set', input.slug!, '--scope', input.scope!,
        ...subjectFlags(input.subject),
        '--title', input.title!,
        '--reason', input.reason!, '--author', 'hub-dashboard',
        ...(input.delivery ? ['--delivery', input.delivery] : []),
        '--json',
      ]
    case 'remove':
      return [
        'doc', 'rm', input.slug!, '--scope', input.scope!,
        ...subjectFlags(input.subject),
        '--reason', input.reason!, '--author', 'hub-dashboard',
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

export const docRemove = (scope: string, subject: string | null, slug: string, reason: string) =>
  jsonDocument<{ removed: boolean }>(docArgv('remove', { scope, subject, slug, reason }))

export const docHistory = (scope: string, subject: string | null, slug: string) =>
  jsonDocument<DocRevisionMetadata[]>(docArgv('history', { scope, subject, slug }))

export const docSubjects = () =>
  jsonDocument<DocSubjects>(docArgv('subjects'))

export async function summarize(prompt: string): Promise<string> {
  return orchProcess(
    ['do', 'summarize', '--agent', 'codex', '--quiet', '--follow',
     '--label', 'daily report sentences'],
    0,
    { stdin: prompt },
  )
}
