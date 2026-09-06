import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { failureReason, outcomeOf } from './outcome.ts'

export const COLLECTION_COMMANDS = new Set(['result', 'wait'])

export type FailoverAttempt = {
  rootId: number; id: number; agent: string; status: string
  error: string | null; failure_kind: string | null; exit_code: number | null
}

type AskingResolution =
  | { state: 'open'; rootId: number }
  | { state: 'running'; rootId: number; runningId: number }
  | { state: 'recoverable'; rootId: number }

/** Resolve what an `asking` status means across the whole conversation. */
function resolveAsking(database: Database, runId: number): AskingResolution {
  const member = database.query('SELECT id, parent_run_id FROM run WHERE id=?').get(runId) as
    { id: number; parent_run_id: number | null } | null
  if (!member) throw new Error(`no run ${runId}`)
  const rootId = member.parent_run_id ?? member.id
  const open = database.query(
    `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
      WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
  ).get(rootId, rootId) as { n: number }
  if (open.n) return { state: 'open', rootId }

  const running = database.query(
    `SELECT id FROM run
      WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
      ORDER BY turn DESC, id DESC LIMIT 1`,
  ).get(rootId, rootId) as { id: number } | null
  return running
    ? { state: 'running', rootId, runningId: running.id }
    : { state: 'recoverable', rootId }
}

/** Resolve conversation turns backward, then failover successors forward. */
export function resolveFailover(database: Database, requestedId: number): {
  requestedId: number; attempts: FailoverAttempt[]; finalId: number; settling: boolean
} {
  const member = database.query('SELECT id, parent_run_id FROM run WHERE id=?').get(requestedId) as
    { id: number; parent_run_id: number | null } | null
  if (!member) throw new Error(`no run ${requestedId}`)
  let rootId = member.parent_run_id ?? member.id
  for (;;) {
    const root = database.query(
      'SELECT retry_of, automatic_failover FROM run WHERE id=?',
    ).get(rootId) as { retry_of: number | null; automatic_failover: number }
    if (!root.retry_of || !root.automatic_failover) break
    const prior = database.query('SELECT id, parent_run_id FROM run WHERE id=?').get(root.retry_of) as
      { id: number; parent_run_id: number | null } | null
    if (!prior) break
    rootId = prior.parent_run_id ?? prior.id
  }

  const attempts: FailoverAttempt[] = []
  for (;;) {
    const latest = database.query(
      `SELECT id, agent, status, error, failure_kind, exit_code
         FROM run WHERE id=? OR parent_run_id=?
        ORDER BY turn DESC, id DESC LIMIT 1`,
    ).get(rootId, rootId) as Omit<FailoverAttempt, 'rootId'>
    attempts.push({ rootId, ...latest })
    const successor = database.query(
      `SELECT id FROM run WHERE automatic_failover=1 AND retry_of IN
         (SELECT id FROM run WHERE id=? OR parent_run_id=?)
        ORDER BY id LIMIT 1`,
    ).get(rootId, rootId) as { id: number } | null
    if (!successor) break
    rootId = successor.id
  }
  const last = attempts.at(-1)!
  const pending = database.query('SELECT pid, no_failover FROM run WHERE id=?').get(last.id) as
    { pid: number | null; no_failover: number }
  let workerAlive = false
  if (pending.pid) {
    try { process.kill(pending.pid, 0); workerAlive = true } catch { /* terminal worker */ }
  }
  const settling = last.status === 'failed' &&
    (last.failure_kind === 'quota' || last.failure_kind === 'auth' ||
      last.failure_kind === 'content_refusal' || last.failure_kind === 'contract') &&
    !pending.no_failover && !last.error?.includes('Failover refused:') && workerAlive
  return { requestedId, attempts, finalId: last.id, settling }
}

export function failoverSummary(attempts: FailoverAttempt[]): string {
  if (attempts.length < 2) return ''
  const deaths = attempts.slice(0, -1).map((attempt) =>
    `${attempt.agent} died (${attempt.failure_kind ?? attempt.status}: ` +
    `${(attempt.error ?? 'no error recorded').replace(/\s+/g, ' ').trim()})`)
  const final = attempts.at(-1)!
  const handoff = final.status === 'ok'
    ? `${final.agent} answered`
    : `${final.agent} took over and ended ${final.status}`
  return `failover: ${deaths.join('; ')}; ${handoff}`
}

function dur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const t = ms / 1000
  if (t < 60) return `${t.toFixed(1)}s`
  const m = Math.floor(t / 60)
  if (m < 60) return `${m}m ${String(Math.round(t % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function scoreHint(id: number, jobName: string, parent: number | null, writesRepo: (job: string) => boolean): string {
  const target = parent ?? id
  const writes = writesRepo(jobName)
  return `orch score ${target} <none|partial|full> [wrong|mixed|right]`
    + (writes ? ' [drifted|partial|faithful]' : '')
    + ' --note "..."'
    + (parent ? `   # the whole conversation, not turn ${id}` : '')
}

function evidenceNote(row: { evidence_excluded: string | null }): string {
  return row.evidence_excluded
    ? `\n  not routing evidence: ${row.evidence_excluded}`
    : ''
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function mcpNote(row: {
  agent: string; cwd: string | null; mcp: number | null; mcp_server: string | null
  mcp_connected: number | null; mcp_error: string | null
}): string {
  if (!row.mcp) return ''
  const source = row.mcp_server ?? 'project MCP'
  if (row.mcp_connected === 1) return `\n  mcp:       ${source} connected`
  const state = row.mcp_connected === 0 ? 'NOT CONNECTED' : 'UNVERIFIED'
  let note = `\n  mcp:       ${source} ${state}`
  if (row.mcp_error) note += ` — ${row.mcp_error}`
  if (row.agent === 'grok' && row.cwd && /folder untrusted/i.test(row.mcp_error ?? '')) {
    note += `\n  trust:     grok --cwd ${shellArg(row.cwd)} --trust`
  }
  return note
}

function partialOutputDocument(row: {
  id: number; status: string
  failure_kind: string | null; exit_code: number | null
}, output: string): string {
  let partialOutput: unknown = output
  try { partialOutput = JSON.parse(output) } catch { /* Preserve non-JSON output as text. */ }
  return JSON.stringify({
    run: {
      id: row.id,
      status: row.status,
      complete: false,
      failure_kind: row.failure_kind,
      exit_code: row.exit_code,
    },
    partial_output: partialOutput,
  }, null, 2)
}

export function collectResult(
  database: Database, argv: string[], writesRepo: (job: string) => boolean = () => false,
): void {
  const unknown = argv.slice(2).find((arg) => arg !== '--quiet')
  if (unknown) {
    throw new Error(`unrecognised argument: ${unknown}\nworking form: orch result <run-id> [--quiet]`)
  }
  const id = Number(argv[1])
  if (!id) throw new Error('orch result <run-id>')
  const chain = resolveFailover(database, id)
  const row = database.query(
    `SELECT id, agent, job, status, latency_ms, vendor_tokens, output_path, error,
            failure_kind, exit_code, parent_run_id, evidence_excluded, base_commit,
            cwd, mcp, mcp_server, mcp_connected, mcp_error
       FROM run WHERE id = ?`,
  ).get(chain.finalId) as {
    id: number; agent: string; job: string; status: string; latency_ms: number | null
    vendor_tokens: number | null; output_path: string | null; error: string | null
    failure_kind: string | null; exit_code: number | null; parent_run_id: number | null
    evidence_excluded: string | null; base_commit: string | null
    cwd: string | null; mcp: number | null; mcp_server: string | null
    mcp_connected: number | null; mcp_error: string | null
  } | null
  if (!row) throw new Error(`no run ${id}`)

  const asking = row.status === 'asking' ? resolveAsking(database, row.id) : null
  const outcome = outcomeOf(row)
  const baseNote = row.base_commit ? `\n  base:      ${row.base_commit}` : ''
  if (!outcome.terminal || chain.settling) {
    console.error(`run ${id} (${row.agent}/${row.job}) is still running`)
    process.exit(2)
  }
  const output = row.output_path && existsSync(row.output_path)
    ? readFileSync(row.output_path, 'utf8')
    : null
  if (!outcome.ok) {
    if (output !== null) {
      console.error(`\n— INCOMPLETE partial output from run ${row.id} (${row.status}) follows`)
      console.log(partialOutputDocument(row, output))
    }
  } else if (output !== null) {
    console.log(output)
  }
  const chainNote = failoverSummary(chain.attempts)
  if (chainNote) console.error(`\n— ${chainNote}`)
  if (asking) {
    console.error(
      (asking.state === 'open'
        ? `\n— run ${id} asking — waiting on a ruling: orch answer ${asking.rootId} ...`
        : asking.state === 'running'
          ? `\n— run ${id} asking — resumed as run ${asking.runningId}, which is still running`
          : `\n— run ${id} asking — recoverable: orch continue ${asking.rootId}`) +
      baseNote + mcpNote(row) + evidenceNote(row),
    )
    return
  }
  if (!outcome.ok) {
    console.error(
      `\n— run ${id} ${row.status}: ${failureReason(row)}` + baseNote + mcpNote(row) + evidenceNote(row),
    )
    process.exit(1)
  }
  if (!argv.includes('--quiet')) {
    console.error(
      `\n— run ${row.id} · ${row.agent} · ${dur(row.latency_ms)}` +
        (row.vendor_tokens ? ` · ${row.vendor_tokens.toLocaleString()} vendor tokens` : '') +
        `\n  score it:  ${scoreHint(row.id, row.job, row.parent_run_id, writesRepo)}` +
        baseNote + mcpNote(row) + evidenceNote(row),
    )
  }
}

const VALUE_FLAGS = new Set(['--timeout'])

export async function collectWait(
  database: Database, argv: string[], beforePoll: () => void = () => {},
): Promise<void> {
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (/^\d+$/.test(arg)) continue
    if (arg === '--timeout') {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          'argument --timeout needs a value\n' +
          'working form: orch wait <run-id>... [--timeout SECONDS]',
        )
      }
      i++
      continue
    }
    throw new Error(
      `unrecognised argument: ${arg}\n` +
      'working form: orch wait <run-id>... [--timeout SECONDS]',
    )
  }
  const ids = rest
    .filter((x, i) => /^\d+$/.test(x) && !VALUE_FLAGS.has(rest[i - 1] ?? ''))
    .map(Number)
  if (!ids.length) throw new Error('orch wait <run-id>...')
  const timeoutAt = argv.indexOf('--timeout')
  const timeoutMs = Number(timeoutAt >= 0 ? argv[timeoutAt + 1] : 1800) * 1000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    beforePoll()
    const outcomes = ids.map((id) => {
      const chain = resolveFailover(database, id)
      const row = database.query(
        'SELECT id, status, error, failure_kind, exit_code FROM run WHERE id=?',
      ).get(chain.finalId) as {
        id: number; status: string; error: string | null
        failure_kind: string | null; exit_code: number | null
      }
      const asking = row.status === 'asking' ? resolveAsking(database, row.id) : null
      const outcome = asking?.state === 'running'
        ? { terminal: false, ok: false, line: 'running' }
        : asking?.state === 'open'
          ? { terminal: true, ok: true,
              line: `asking - orch inbox (or orch answer ${asking.rootId})` }
          : asking?.state === 'recoverable'
            ? { terminal: true, ok: true,
                line: `asking - recoverable: orch continue ${asking.rootId}` }
            : outcomeOf(row)
      return { requestedId: id, row, chain, outcome }
    })
    const running = outcomes.filter(({ outcome, chain }) => !outcome.terminal || chain.settling)
    if (!running.length) {
      for (const { requestedId, row, outcome, chain } of outcomes) {
        console.log(`${requestedId}\t${outcome.line}`)
        const note = failoverSummary(chain.attempts)
        if (note) console.log(`  ${note}`)
        if (!outcome.ok) console.log(`  ${failureReason(row)}`)
      }
      if (outcomes.some(({ outcome }) => !outcome.ok)) process.exit(1)
      return
    }
    if (Date.now() >= deadline) {
      console.error(`still running after ${Math.round(timeoutMs / 1000)}s: ` +
        running.map(({ row }) => row.id).join(', '))
      process.exit(2)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

export async function collect(database: Database, argv: string[], beforePoll?: () => void): Promise<void> {
  if (argv[0] === 'result') collectResult(database, argv)
  else if (argv[0] === 'wait') await collectWait(database, argv, beforePoll)
  else throw new Error(`not a collection command: ${argv[0] ?? ''}`)
}
