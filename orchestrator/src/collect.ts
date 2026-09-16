import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { persistedRunArtifactPath, rewriteFilesWrittenPaths } from './artifact-paths.ts'
import { clock } from './clock.ts'
import { FAILS_OVER } from './failure.ts'
import { parseMcpProbe } from './mcp-probe.ts'
import { failureReason, outcomeOf } from './outcome.ts'
import { TRUNCATED_TRANSCRIPT_BYTES, visibleTranscriptText } from './result-output.ts'
import type { ObservedDeadRun } from './run-liveness.ts'

export const COLLECTION_COMMANDS = new Set(['result', 'wait'])

const THIN_OUTPUT_BYTES = 1024
const THIN_OUTPUT_LATENCY_MS = 5 * 60_000

/** A reader-facing suspicion only: this never enters status, scoring, or routing. */
export function thinOutputWarning(row: {
  job: string
  status: string
  latency_ms: number | null
  probe: number
  writesRepo: boolean
  output_path: string | null
}): string | null {
  if (
    row.status !== 'ok' ||
    row.probe ||
    row.latency_ms === null ||
    row.latency_ms <= THIN_OUTPUT_LATENCY_MS ||
    row.writesRepo ||
    !row.output_path ||
    !existsSync(row.output_path)
  )
    return null
  if (process.env.ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT === row.output_path) {
    unlinkSync(row.output_path)
  }
  let bytes: number
  try {
    bytes = statSync(row.output_path).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (bytes >= THIN_OUTPUT_BYTES) return null
  return (
    `thin: ${bytes} B after ${dur(row.latency_ms).replaceAll(' ', '')} — ` +
    'check whether the run stopped at a blocker'
  )
}

export type FailoverAttempt = {
  rootId: number
  id: number
  agent: string
  status: string
  error: string | null
  failure_kind: string | null
  exit_code: number | null
}

type AskingResolution =
  | { state: 'open'; rootId: number }
  | { state: 'running'; rootId: number; runningId: number }
  | { state: 'recoverable'; rootId: number }

/** Resolve what an `asking` status means across the whole conversation. */
function resolveAsking(database: Database, runId: number): AskingResolution {
  const member = database.query('SELECT id, parent_run_id FROM run WHERE id=?').get(runId) as {
    id: number
    parent_run_id: number | null
  } | null
  if (!member) throw new Error(`no run ${runId}`)
  const rootId = member.parent_run_id ?? member.id
  const open = database
    .query(
      `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
      WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    )
    .get(rootId, rootId) as { n: number }
  if (open.n) return { state: 'open', rootId }

  const running = database
    .query(
      `SELECT id FROM run
      WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
      ORDER BY turn DESC, id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { id: number } | null
  return running
    ? { state: 'running', rootId, runningId: running.id }
    : { state: 'recoverable', rootId }
}

/** Resolve conversation turns backward, then failover successors forward. */
export function resolveFailover(
  database: Database,
  requestedId: number,
): {
  requestedId: number
  attempts: FailoverAttempt[]
  finalId: number
  settling: boolean
} {
  const member = database
    .query('SELECT id, parent_run_id FROM run WHERE id=?')
    .get(requestedId) as { id: number; parent_run_id: number | null } | null
  if (!member) throw new Error(`no run ${requestedId}`)
  let rootId = member.parent_run_id ?? member.id
  for (;;) {
    const root = database
      .query('SELECT retry_of, automatic_failover FROM run WHERE id=?')
      .get(rootId) as { retry_of: number | null; automatic_failover: number }
    if (!root.retry_of || !root.automatic_failover) break
    const prior = database
      .query('SELECT id, parent_run_id FROM run WHERE id=?')
      .get(root.retry_of) as { id: number; parent_run_id: number | null } | null
    if (!prior) break
    rootId = prior.parent_run_id ?? prior.id
  }

  const attempts: FailoverAttempt[] = []
  for (;;) {
    const latest = database
      .query(
        `SELECT id, agent, status, error, failure_kind, exit_code
         FROM run WHERE id=? OR parent_run_id=?
        ORDER BY turn DESC, id DESC LIMIT 1`,
      )
      .get(rootId, rootId) as Omit<FailoverAttempt, 'rootId'>
    attempts.push({ rootId, ...latest })
    const successor = database
      .query(
        `SELECT id FROM run WHERE automatic_failover=1 AND retry_of IN
         (SELECT id FROM run WHERE id=? OR parent_run_id=?)
        ORDER BY id LIMIT 1`,
      )
      .get(rootId, rootId) as { id: number } | null
    if (!successor) break
    rootId = successor.id
  }
  const last = attempts.at(-1)!
  const pending = database.query('SELECT pid, no_failover FROM run WHERE id=?').get(last.id) as {
    pid: number | null
    no_failover: number
  }
  let workerAlive = false
  if (pending.pid) {
    try {
      process.kill(pending.pid, 0)
      workerAlive = true
    } catch {
      /* terminal worker */
    }
  }
  const settling =
    last.status === 'failed' &&
    last.failure_kind != null &&
    (FAILS_OVER as readonly string[]).includes(last.failure_kind) &&
    !pending.no_failover &&
    !last.error?.includes('Failover refused:') &&
    workerAlive
  return { requestedId, attempts, finalId: last.id, settling }
}

export function failoverSummary(attempts: FailoverAttempt[]): string {
  if (attempts.length < 2) return ''
  const deaths = attempts
    .slice(0, -1)
    .map(
      (attempt) =>
        `${attempt.agent} died (${attempt.failure_kind ?? attempt.status}: ` +
        `${(attempt.error ?? 'no error recorded').replace(/\s+/g, ' ').trim()})`,
    )
  const final = attempts.at(-1)!
  const handoff =
    final.status === 'ok'
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

function scoreHint(
  id: number,
  jobName: string,
  parent: number | null,
  scoreSuffix: (job: string) => string,
): string {
  const target = parent ?? id
  return (
    `orch score ${target} <none|partial|full> [wrong|mixed|right]` +
    scoreSuffix(jobName) +
    ' --note "..."' +
    (parent ? `   # the whole conversation, not turn ${id}` : '')
  )
}

function evidenceNote(row: { evidence_excluded: string | null }): string {
  return row.evidence_excluded ? `\n  not routing evidence: ${row.evidence_excluded}` : ''
}

/** The branch created for this run or for the conversation it belongs to. */
export function mintedBranchForRun(database: Database, runId: number): string | null {
  const run = database
    .query('SELECT id, parent_run_id, minted_branch FROM run WHERE id=?')
    .get(runId) as {
    id: number
    parent_run_id: number | null
    minted_branch: string | null
  } | null
  if (!run) return null
  if (run.minted_branch) return run.minted_branch

  const rootId = run.parent_run_id ?? run.id
  const chained = database
    .query(
      `SELECT minted_branch FROM run
      WHERE minted_branch IS NOT NULL AND (id=? OR parent_run_id=?)
      ORDER BY id LIMIT 1`,
    )
    .get(rootId, rootId) as { minted_branch: string | null } | null
  return chained?.minted_branch ?? null
}

/**
 * A writer that changed files but authored no commit leaves its branch at the
 * base; close-out then reclaims the tree and the work survives only in the
 * extracted artifacts. Say so, naming only the artifact paths that exist.
 */
export function noCommitNote(
  facts: {
    base_commit: string | null
    branch_kept_tip: string | null
    changed_paths: string | null
  },
  artifactsDir: string | null,
): string {
  if (!facts.branch_kept_tip || facts.branch_kept_tip !== facts.base_commit) return ''
  let changed: unknown = null
  try {
    changed = JSON.parse(facts.changed_paths ?? 'null')
  } catch {
    /* unreadable is not evidence */
  }
  if (!Array.isArray(changed) || !changed.length) return ''
  const copies = artifactsDir
    ? ['uncommitted.patch', 'untracked']
        .map((name) => join(artifactsDir, name))
        .filter((path) => existsSync(path))
    : []
  return (
    `\n  no commit authored: the branch is at its base; the work exists only in ` +
    (copies.length
      ? copies.join(' and ')
      : `no extracted artifact (checked ${artifactsDir ?? 'nothing: the run records no runs directory'})`)
  )
}

/** Branch footer shared by result, wait and follow. */
export function branchNote(database: Database, runId: number): string {
  const branch = mintedBranchForRun(database, runId)
  if (!branch) return ''
  const row = database
    .query('SELECT COALESCE(parent_run_id, id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  const root = row
    ? (database
        .query(
          'SELECT base_commit, branch_kept_tip, changed_paths, prompt_path FROM run WHERE id=?',
        )
        .get(row.root_id) as
        | (Parameters<typeof noCommitNote>[0] & { prompt_path: string | null })
        | null)
    : null
  // Prompts and per-run artifacts share the runs directory; derive it from the
  // row rather than importing the artifact module into the degraded graph.
  const artifacts = root?.prompt_path
    ? join(dirname(root.prompt_path), String(row!.root_id), 'artifacts')
    : null
  return `\n  branch:    ${branch}` + (root ? noCommitNote(root, artifacts) : '')
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function mcpNote(row: {
  agent: string
  cwd: string | null
  mcp: number | null
  mcp_server: string | null
  mcp_connected: number | null
  mcp_error: string | null
  mcp_probe: string | null
}): string {
  if (!row.mcp) return ''
  const source = row.mcp_server ?? 'project MCP'
  let note = ''
  if (row.mcp_connected === 1) note = `\n  mcp:       ${source} connected`
  else if (row.mcp_connected === 0 && row.mcp_error?.startsWith('mirror:')) {
    note =
      `\n  mcp:       ${source} NOT CONNECTED — ${row.mcp_error}` +
      '\n  MIRROR — not the live database'
  } else {
    const state = row.mcp_connected === 0 ? 'NOT CONNECTED' : 'UNVERIFIED'
    note = `\n  mcp:       ${source} ${state}`
    if (row.mcp_error) note += ` — ${row.mcp_error}`
  }
  if (row.agent === 'grok' && row.cwd && /folder untrusted/i.test(row.mcp_error ?? '')) {
    note += `\n  trust:     grok --cwd ${shellArg(row.cwd)} --trust`
  }
  const probe = parseMcpProbe(row.mcp_probe)
  if (probe) {
    note += `\n  mcp_probe: ${probe.ok ? 'ok' : 'fail'} ${probe.tool} ${probe.durationMs}ms`
    if (probe.detail) note += ` — ${probe.detail}`
    if (probe.error) note += ` — ${probe.error}`
    if (probe.namesSeen.length) note += `\n  names:     ${probe.namesSeen.join(', ')}`
  }
  return note
}

function partialOutputDocument(
  row: {
    id: number
    status: string
    failure_kind: string | null
    exit_code: number | null
  },
  output: string,
): string {
  let partialOutput: unknown = output
  try {
    partialOutput = JSON.parse(output)
  } catch {
    /* Preserve non-JSON output as text. */
  }
  return JSON.stringify(
    {
      run: {
        id: row.id,
        status: row.status,
        complete: false,
        failure_kind: row.failure_kind,
        exit_code: row.exit_code,
      },
      partial_output: partialOutput,
    },
    null,
    2,
  )
}

function utf8Tail(text: string, bytes: number): string {
  const encoded = Buffer.from(text)
  if (encoded.byteLength <= bytes) return text
  let start = encoded.byteLength - bytes
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++
  return encoded.subarray(start).toString('utf8')
}

function collectionRunsDirectory(): string | null {
  return (
    process.env.ORCH_RUNS ??
    (process.env.ORCH_DB ? join(dirname(process.env.ORCH_DB), 'runs') : null)
  )
}

export type CollectResultPresentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  exit(code: number): never
}

const consoleCollectResultPresentation: CollectResultPresentation = {
  log: (...values) => console.log(...values),
  error: (...values) => console.error(...values),
  exit: (code) => process.exit(code),
}

export function collectResult(
  database: Database,
  argv: string[],
  scoreSuffix: (job: string) => string = () => '',
  presentation: CollectResultPresentation = consoleCollectResultPresentation,
): void {
  const unknown = argv.slice(2).find((arg) => arg !== '--quiet' && arg !== '--artifacts')
  if (unknown) {
    throw new Error(
      `unrecognised argument: ${unknown}\nworking form: orch result <run-id> [--quiet] [--artifacts]`,
    )
  }
  const id = Number(argv[1])
  if (!id) throw new Error('orch result <run-id>')
  const chain = resolveFailover(database, id)
  const row = database
    .query(
      `SELECT id, agent, job, status, latency_ms, vendor_tokens, output_path, error,
            failure_kind, exit_code, parent_run_id, evidence_excluded, base_commit,
            cwd, mcp, mcp_server, mcp_connected, mcp_error, mcp_probe,
            review_provenance, provenance_status
       FROM run WHERE id = ?`,
    )
    .get(chain.finalId) as {
    id: number
    agent: string
    job: string
    status: string
    latency_ms: number | null
    vendor_tokens: number | null
    output_path: string | null
    error: string | null
    failure_kind: string | null
    exit_code: number | null
    parent_run_id: number | null
    evidence_excluded: string | null
    base_commit: string | null
    cwd: string | null
    mcp: number | null
    mcp_server: string | null
    mcp_connected: number | null
    mcp_error: string | null
    mcp_probe: string | null
    review_provenance: string | null
    provenance_status: string | null
  } | null
  if (!row) throw new Error(`no run ${id}`)

  if (argv.includes('--artifacts')) {
    const runsRoot = collectionRunsDirectory()
    const dir = runsRoot ? join(runsRoot, String(chain.finalId), 'artifacts') : ''
    const files: string[] = []
    if (existsSync(dir)) {
      for (const name of readdirSync(dir, { recursive: true })) {
        const p = join(dir, String(name))
        try {
          if (statSync(p).isFile()) files.push(p)
        } catch {
          /* raced */
        }
      }
    }
    if (!files.length) presentation.log('no artifacts')
    else for (const file of files.sort()) presentation.log(file)
  }

  const asking = row.status === 'asking' ? resolveAsking(database, row.id) : null
  const outcome = outcomeOf(row)
  const baseNote = row.base_commit ? `\n  base:      ${row.base_commit}` : ''
  if (!outcome.terminal || chain.settling) {
    presentation.error(`run ${id} (${row.agent}/${row.job}) is still running`)
    presentation.exit(2)
  }
  const output =
    row.output_path && existsSync(row.output_path) ? readFileSync(row.output_path, 'utf8') : null
  if (row.review_provenance) {
    try {
      const provenance = JSON.parse(row.review_provenance) as {
        could_not_verify?: string[]
        substitutes?: string[]
      }
      presentation.error(`PROVENANCE${row.provenance_status ? ` (${row.provenance_status})` : ''}`)
      presentation.error(`  could not verify: ${provenance.could_not_verify?.join('; ') || 'none'}`)
      presentation.error(`  substitutes: ${provenance.substitutes?.join('; ') || 'none'}`)
    } catch {
      /* a legacy malformed value remains visible in the raw output */
    }
  }
  if (!outcome.ok) {
    if (output !== null) {
      if (row.failure_kind === 'truncated') {
        presentation.log('TRUNCATED at the output ceiling — this is the transcript, not a result')
        presentation.log(
          utf8Tail(visibleTranscriptText(row.agent, output), TRUNCATED_TRANSCRIPT_BYTES),
        )
      } else {
        presentation.error(
          `\n— INCOMPLETE partial output from run ${row.id} (${row.status}) follows`,
        )
        presentation.log(partialOutputDocument(row, output))
      }
    }
  } else if (output !== null) {
    const runsRoot = collectionRunsDirectory()
    const rewritten = runsRoot
      ? rewriteFilesWrittenPaths(output, (entry) =>
          persistedRunArtifactPath(row.id, runsRoot, entry, row.cwd),
        )
      : null
    presentation.log(rewritten ?? output)
  }
  const chainNote = failoverSummary(chain.attempts)
  if (chainNote) presentation.error(`\n— ${chainNote}`)
  if (asking) {
    presentation.error(
      (asking.state === 'open'
        ? `\n— run ${id} asking — waiting on a ruling: orch answer ${asking.rootId} ...`
        : asking.state === 'running'
          ? `\n— run ${id} asking — resumed as run ${asking.runningId}, which is still running`
          : `\n— run ${id} asking — recoverable: orch continue ${asking.rootId}`) +
        baseNote +
        mcpNote(row) +
        evidenceNote(row),
    )
    return
  }
  if (!outcome.ok) {
    presentation.error(
      `\n— run ${id} ${row.status}: ${failureReason(row)}` +
        baseNote +
        mcpNote(row) +
        evidenceNote(row),
    )
    presentation.exit(1)
  }
  if (!argv.includes('--quiet')) {
    presentation.error(
      `\n— run ${row.id} · ${row.agent} · ${dur(row.latency_ms)}` +
        (row.vendor_tokens !== null
          ? ` · ${row.vendor_tokens.toLocaleString()} vendor tokens`
          : ' · vendor tokens not reported') +
        `\n  score it:  ${scoreHint(row.id, row.job, row.parent_run_id, scoreSuffix)}` +
        branchNote(database, row.id) +
        baseNote +
        mcpNote(row) +
        evidenceNote(row),
    )
  }
}

const VALUE_FLAGS = new Set(['--timeout'])

export async function collectWait(
  database: Database,
  argv: string[],
  beforePoll: () => void | number | ObservedDeadRun[] = () => {},
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
      `unrecognised argument: ${arg}\n` + 'working form: orch wait <run-id>... [--timeout SECONDS]',
    )
  }
  const ids = rest
    .filter((x, i) => /^\d+$/.test(x) && !VALUE_FLAGS.has(rest[i - 1] ?? ''))
    .map(Number)
  if (!ids.length) throw new Error('orch wait <run-id>...')
  const timeoutAt = argv.indexOf('--timeout')
  const timeoutMs = Number(timeoutAt >= 0 ? argv[timeoutAt + 1] : 1800) * 1000
  const deadline = clock().now() + timeoutMs
  const observedTerminal = new Set<number>()
  for (;;) {
    const observation = beforePoll()
    const outcomes = ids.map((id) => {
      const chain = resolveFailover(database, id)
      const row = database
        .query('SELECT id, status, error, failure_kind, exit_code FROM run WHERE id=?')
        .get(chain.finalId) as {
        id: number
        status: string
        error: string | null
        failure_kind: string | null
        exit_code: number | null
      }
      const asking = row.status === 'asking' ? resolveAsking(database, row.id) : null
      const outcome =
        asking?.state === 'running'
          ? { terminal: false, ok: false, line: 'running' }
          : asking?.state === 'open'
            ? {
                terminal: true,
                ok: true,
                line: `asking - orch inbox (or orch answer ${asking.rootId})`,
              }
            : asking?.state === 'recoverable'
              ? {
                  terminal: true,
                  ok: true,
                  line: `asking - recoverable: orch continue ${asking.rootId}`,
                }
              : outcomeOf(row)
      return { requestedId: id, row, chain, outcome }
    })
    if (Array.isArray(observation)) {
      const requestedRows = new Set(outcomes.map(({ row }) => row.id))
      for (const dead of observation) {
        if (!requestedRows.has(dead.id) || observedTerminal.has(dead.id)) continue
        observedTerminal.add(dead.id)
        console.error(`run ${dead.id}: process gone, not terminalised (read-only linked worktree)`)
      }
    }
    const running = outcomes.filter(
      ({ row, outcome, chain }) =>
        !observedTerminal.has(row.id) && (!outcome.terminal || chain.settling),
    )
    if (!running.length) {
      for (const { requestedId, row, outcome, chain } of outcomes) {
        if (observedTerminal.has(row.id)) continue
        console.log(`${requestedId}\t${outcome.line}`)
        const note = failoverSummary(chain.attempts)
        if (note) console.log(`  ${note}`)
        if (!outcome.ok) console.log(`  ${failureReason(row)}`)
        const branch = branchNote(database, row.id)
        if (branch) console.log(branch.slice(1))
      }
      if (observedTerminal.size || outcomes.some(({ outcome }) => !outcome.ok)) process.exit(1)
      return
    }
    if (clock().now() >= deadline) {
      console.error(
        `still running after ${Math.round(timeoutMs / 1000)}s: ` +
          running.map(({ row }) => row.id).join(', '),
      )
      process.exit(2)
    }
    await new Promise<void>((resolve) => {
      clock().setTimeout(resolve, 2000)
    })
  }
}

export async function collect(
  database: Database,
  argv: string[],
  beforePoll?: () => void,
): Promise<void> {
  if (argv[0] === 'result') collectResult(database, argv)
  else if (argv[0] === 'wait') await collectWait(database, argv, beforePoll)
  else throw new Error(`not a collection command: ${argv[0] ?? ''}`)
}
