/**
 * The orchestrator, read through its CLI.
 *
 * Never by opening `orch.db`: a database shared between two concerns is how two
 * concerns quietly become one, which is the root canon's line and the reason
 * `orch` grew `--json` flags rather than hub growing a second connection.
 */
import { existsSync } from 'node:fs'
import { refreshProjects, type RegisteredProject } from './projects.ts'
/**
 * Resolved from THIS FILE's location, at module load.
 *
 * Which means a long-running `hub serve` keeps pointing wherever it was started
 * from, for as long as it lives. When the checkout was renamed the server that
 * had been up since the previous evening went on calling a `bin/orch` that no
 * longer existed, and every view needing the orchestrator answered HTTP 500
 * with nothing on screen saying why. Restarting it was the whole fix; working
 * that out was not.
 */
const ORCH = new URL('../../bin/orch', import.meta.url).pathname

async function orch(
  args: string[],
  timeoutMs = 20_000,
  opts: { parseJson?: boolean; stdin?: string } = {},
): Promise<unknown> {
  /**
   * A MISSING BINARY IS NAMED, not left as a spawn error.
   *
   * `Bun.spawn` on a path that does not exist reports ENOENT as though the
   * command were missing, which reads as "orch is not installed" — and the
   * actual cause is that this process is older than the checkout it is running
   * from. Saying so turns an opaque 500 into an instruction.
   */
  if (!existsSync(ORCH)) {
    throw new Error(
      `orch is not at ${ORCH}. This server was started from a checkout that has ` +
      `since moved or been renamed; restart it from the current one.`,
    )
  }
  const proc = Bun.spawn([ORCH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : 'ignore',
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(err.trim() || out.trim() || `orch ${args[0]} exited ${code}`)
    return opts.parseJson === false ? out.trim() : JSON.parse(out)
  } finally { clearTimeout(timer) }
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

export async function projectAdd(body: ProjectAddBody): Promise<RegisteredProject> {
  const result = await orch(projectArgv('add', body.name, body)) as RegisteredProject
  refreshProjects()
  return result
}

export async function projectSet(
  name: string, body: ProjectWriteBody,
): Promise<RegisteredProject> {
  const result = await orch(projectArgv('set', name, body)) as RegisteredProject
  refreshProjects()
  return result
}

export async function projectRemove(name: string): Promise<void> {
  await orch(projectArgv('remove', name), 20_000, { parseJson: false })
  refreshProjects()
}

export type OrchAgent = {
  agent: string; billing: string; cooling: number | null
  lastStatus: string | null; lastKind: string | null; minsAgo: number | null
}

export type OrchState = {
  live: { id: number; agent: string; job: string; repo: string | null; started_at: string
          prompt_head: string }[]
  stale: number
  matrix: { job: string; agent: string; runs: number; judged: number; failures: number
            pts: number; lat: number | null; toks: number | null }[]
  guide: { job: string; best: unknown; quickest: unknown; untried: string[]
           provisional?: boolean }[]
  health: OrchAgent[]
  totals: { runs: number; failed: number; stale_n: number; toks: number; scored: number }
  unscored: number
  spawns: { decision: string; why: string; n: number }[]
  agents: { name: string; billing: string; caps: Record<string, boolean> }[]
}

export const state = (days: number | null) =>
  orch(['state', ...(days ? ['--days', String(days)] : [])]) as Promise<OrchState>

export const runDetail = (id: number) => orch(['run', String(id)])

/**
 * Score a run as a person, from the dashboard.
 *
 * `--scorer` is the session gate's one named exception: the gate exists so an
 * AGENT cannot judge a run it never read, and someone clicking a verdict has
 * the output in front of them. Recording who judged it makes the exception
 * auditable rather than invisible - which is what the orchestrator's own page
 * did by writing the score table behind the CLI's back.
 */
export async function score(
  id: number, delivery: string, quality: string | null, fidelity: string | null,
  note: string | null,
) {
  const args = ['score', String(id), delivery, ...(quality ? [quality] : []),
                ...(fidelity ? [fidelity] : []),
                '--scorer', 'hub-dashboard', ...(note ? ['--note', note] : [])]
  const proc = Bun.spawn([ORCH, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(err.trim() || out.trim() || `orch score exited ${code}`)
  return out.trim()
}

export type DocScope = 'project' | 'machine' | 'agent' | 'job' | 'global'

export type DocRow = {
  id: number
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
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
}

export type DocArgvInput = {
  scope?: string
  subject?: string | null
  slug?: string
  title?: string
  body?: string
}

export type DocOp = 'list' | 'get' | 'set' | 'remove' | 'subjects'

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
        '--json',
      ]
    case 'remove':
      return [
        'doc', 'rm', input.slug!, '--scope', input.scope!,
        ...subjectFlags(input.subject),
        '--json',
      ]
    case 'subjects':
      return ['doc', 'subjects', '--json']
  }
}

export const docList = (filters: DocListFilters = {}) =>
  orch(docArgv('list', filters)) as Promise<DocRow[]>

export const docGet = (scope: string, subject: string | null, slug: string) =>
  orch(docArgv('get', { scope, subject, slug })) as Promise<DocRow>

export const docSet = (input: DocSetInput) =>
  orch(docArgv('set', input), 20_000, { stdin: input.body }) as Promise<DocRow>

export const docRemove = (scope: string, subject: string | null, slug: string) =>
  orch(docArgv('remove', { scope, subject, slug })) as Promise<{ removed: boolean }>

export const docSubjects = () =>
  orch(docArgv('subjects')) as Promise<DocSubjects>
