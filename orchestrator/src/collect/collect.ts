import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveRunsDirectory } from '../../../shared/state-directory.ts'
import { persistedRunArtifactPath, rewriteFilesWrittenPaths } from '../artifact-paths.ts'
import { retainedBranchPruneCommand, retainedBranchReason } from '../close/retained-branch.ts'
import { FAILS_OVER } from '../failure/failure.ts'
import { parseMcpProbe } from '../mcp/mcp-probe.ts'
import { failureReason, outcomeOf } from '../outcome.ts'
import { questionOpenSql } from '../run/question-open.ts'
import type { ObservedDeadRun } from '../run/run-liveness.ts'
import { TRUNCATED_TRANSCRIPT_BYTES, visibleTranscriptText } from './result-output.ts'

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
      WHERE (r.id = ? OR r.parent_run_id = ?) AND ${questionOpenSql('q')}`,
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

function filedNotesNote(runId: number): string {
  const path = join(resolveRunsDirectory(process.env), String(runId), 'events.jsonl')
  if (!existsSync(path)) return ''
  const notes = readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as {
          type?: string
          noteId?: unknown
          candidateIds?: unknown
        }
        return event.type === 'note' && Number.isSafeInteger(event.noteId)
          ? [
              {
                noteId: event.noteId as number,
                candidateIds: Array.isArray(event.candidateIds)
                  ? event.candidateIds.filter((id): id is number => Number.isSafeInteger(id))
                  : [],
              },
            ]
          : []
      } catch {
        return []
      }
    })
  if (!notes.length) return ''
  return `\n  notes:     ${notes
    .map(
      (note) =>
        `${note.noteId}${note.candidateIds.length ? ` (near ${note.candidateIds.join(', ')})` : ''}`,
    )
    .join('; ')}`
}

/** The branch this turn actually ran on. */
export function mintedBranchForRun(database: Database, runId: number): string | null {
  const run = database.query('SELECT branch, minted_branch FROM run WHERE id=?').get(runId) as {
    branch: string | null
    minted_branch: string | null
  } | null
  if (!run) return null
  return run.branch ?? run.minted_branch
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
  const turn = database
    .query(
      `SELECT base_commit, branch_kept, branch_kept_tip, changed_paths, prompt_path, repo, launch_key
       FROM run WHERE id=?`,
    )
    .get(runId) as
    | (Parameters<typeof noCommitNote>[0] & {
        branch_kept: string | null
        prompt_path: string | null
        repo: string | null
        launch_key: string | null
      })
    | null
  // Prompts and per-run artifacts share the runs directory; derive it from the
  // row rather than importing the artifact module into the degraded graph.
  const artifacts = turn?.prompt_path
    ? join(dirname(turn.prompt_path), String(runId), 'artifacts')
    : null
  const retained = turn?.branch_kept
  const prune = retained ? retainedBranchPruneCommand(turn.repo, turn.launch_key) : null
  return (
    `\n  branch:    ${branch}${turn ? noCommitNote(turn, artifacts) : ''}` +
    (retained ? `\n  retained:  ${retainedBranchReason(retained)}` : '') +
    (prune ? `\n  prune:     ${prune}` : '')
  )
}

/** Tell the caller how to recover a released writer tree without inspecting lifecycle state. */
export function releasedWritingTreeNote(
  facts: { writingRun: boolean; worktree: string | null },
  runId: number,
): string {
  return facts.writingRun && facts.worktree === null
    ? `\n  open tree:  orch tree open ${runId}`
    : ''
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

export type CollectResultPresentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  exit(code: number): never
}

/** A successful run may carry a non-failing outcome note in its error column. */
export function okOutcomeNote(row: { status: string; error: string | null }): string {
  return row.status === 'ok' && row.error ? `\n  ${row.error}` : ''
}

function logOkOutcomeNote(row: { status: string; error: string | null }): void {
  const note = okOutcomeNote(row)
  if (note) console.log(note.slice(1))
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
  writingJob: (job: string) => boolean = () => false,
): void {
  const unknown = argv.slice(2).find((arg) => arg !== '--quiet' && arg !== '--artifacts')
  if (unknown) {
    throw new Error(
      `unrecognized argument: ${unknown}\nworking form: orch result <run-id> [--quiet] [--artifacts]`,
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
            review_provenance, provenance_status, worktree
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
    worktree: string | null
  } | null
  if (!row) throw new Error(`no run ${id}`)

  if (argv.includes('--artifacts')) {
    const runsRoot = resolveRunsDirectory(process.env)
    const dir = join(runsRoot, String(chain.finalId), 'artifacts')
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
    const runsRoot = resolveRunsDirectory(process.env)
    const rewritten =
      rewriteFilesWrittenPaths(output, (entry) =>
        persistedRunArtifactPath(row.id, runsRoot, entry, row.cwd),
      ) ?? output
    presentation.log(rewritten)
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
        filedNotesNote(row.id) +
        evidenceNote(row),
    )
    return
  }
  if (!outcome.ok) {
    presentation.error(
      `\n— run ${id} ${row.status}: ${failureReason(row)}` +
        baseNote +
        mcpNote(row) +
        filedNotesNote(row.id) +
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
        okOutcomeNote(row) +
        `\n  score it:  ${scoreHint(row.id, row.job, row.parent_run_id, scoreSuffix)}` +
        branchNote(database, row.id) +
        releasedWritingTreeNote(
          { writingRun: writingJob(row.job), worktree: row.worktree },
          row.id,
        ) +
        baseNote +
        mcpNote(row) +
        filedNotesNote(row.id) +
        evidenceNote(row),
    )
  }
}

const VALUE_FLAGS = new Set(['--timeout'])

export type CollectedWaitRun = {
  requestedId: number
  finalId: number
  status: string
  output: string
  error: string | null
  exitCode: number | null
  failureKind: string | null
  ok: boolean
  line: string
  attempts: FailoverAttempt[]
  observedDead: boolean
}

export type CollectWaitServiceResult =
  | { kind: 'finished'; runs: CollectedWaitRun[] }
  | { kind: 'timed-out'; runs: CollectedWaitRun[]; runningIds: number[] }

type CollectWaitServiceOptions = {
  timeoutMs?: number
  beforePoll?: () => void | number | ObservedDeadRun[]
  onObservedDead?: (run: ObservedDeadRun) => void
  readOutput?: (path: string) => string
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

const COLLECT_WAIT_DEFAULT_MS = 1800_000

/** Wait for failover chains and return their terminal records without presenting or exiting. */
export async function collectWaitForRuns(
  database: Database,
  ids: readonly number[],
  options: CollectWaitServiceOptions = {},
): Promise<CollectWaitServiceResult> {
  const timeoutMs = options.timeoutMs ?? COLLECT_WAIT_DEFAULT_MS
  const beforePoll = options.beforePoll ?? (() => {})
  const onObservedDead = options.onObservedDead ?? (() => {})
  const readOutput = options.readOutput ?? ((path: string) => readFileSync(path, 'utf8'))
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)))
  const deadline = now() + timeoutMs
  const observedTerminal = new Set<number>()
  for (;;) {
    const observation = beforePoll()
    const outcomes = ids.map((requestedId) => {
      const chain = resolveFailover(database, requestedId)
      const row = database
        .query('SELECT id, status, output_path, error, failure_kind, exit_code FROM run WHERE id=?')
        .get(chain.finalId) as {
        id: number
        status: string
        output_path: string | null
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
      return { requestedId, row, chain, outcome }
    })
    if (Array.isArray(observation)) {
      const requestedRows = new Set(outcomes.map(({ row }) => row.id))
      for (const dead of observation) {
        if (!requestedRows.has(dead.id) || observedTerminal.has(dead.id)) continue
        observedTerminal.add(dead.id)
        onObservedDead(dead)
      }
    }
    const running = outcomes.filter(
      ({ row, outcome, chain }) =>
        !observedTerminal.has(row.id) && (!outcome.terminal || chain.settling),
    )
    const timedOut = now() >= deadline
    if (!running.length || timedOut) {
      const runs = outcomes.map(
        ({ requestedId, row, chain, outcome }): CollectedWaitRun => ({
          requestedId,
          finalId: row.id,
          status: row.status,
          output: row.output_path && existsSync(row.output_path) ? readOutput(row.output_path) : '',
          error: row.error,
          exitCode: row.exit_code,
          failureKind: row.failure_kind,
          ok: outcome.ok,
          line: outcome.line,
          attempts: chain.attempts,
          observedDead: observedTerminal.has(row.id),
        }),
      )
      if (!running.length) return { kind: 'finished', runs }
      return { kind: 'timed-out', runs, runningIds: running.map(({ row }) => row.id) }
    }
    await sleep(2000)
  }
}

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
      `unrecognized argument: ${arg}\n` + 'working form: orch wait <run-id>... [--timeout SECONDS]',
    )
  }
  const ids = rest
    .filter((x, i) => /^\d+$/.test(x) && !VALUE_FLAGS.has(rest[i - 1] ?? ''))
    .map(Number)
  if (!ids.length) throw new Error('orch wait <run-id>...')
  const timeoutAt = argv.indexOf('--timeout')
  const timeoutMs = timeoutAt >= 0 ? Number(argv[timeoutAt + 1]) * 1000 : COLLECT_WAIT_DEFAULT_MS
  const result = await collectWaitForRuns(database, ids, {
    timeoutMs,
    beforePoll,
    onObservedDead: (run) => {
      console.error(`run ${run.id}: process gone, not terminalised (read-only linked worktree)`)
    },
  })
  if (result.kind === 'timed-out') {
    console.error(
      `still running after ${Math.round(timeoutMs / 1000)}s: ` + result.runningIds.join(', '),
    )
    process.exit(2)
  }
  for (const run of result.runs) {
    if (run.observedDead) continue
    console.log(`${run.requestedId}\t${run.line}`)
    logOkOutcomeNote(run)
    const note = failoverSummary(run.attempts)
    if (note) console.log(`  ${note}`)
    if (!run.ok) {
      console.log(
        `  ${failureReason({
          status: run.status,
          error: run.error,
          failure_kind: run.failureKind,
          exit_code: run.exitCode,
        })}`,
      )
    }
    const branch = branchNote(database, run.finalId)
    if (branch) console.log(branch.slice(1))
  }
  if (result.runs.some((run) => run.observedDead || !run.ok)) process.exit(1)
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
