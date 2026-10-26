import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { resolveRunsDirectory } from '../../../shared/state-directory.ts'
import {
  persistedRunArtifactPath,
  runScratchReplyPath,
  rewriteFilesWrittenPaths,
  rewriteScratchDirPaths,
} from '../artifact-paths.ts'
import { retainedBranchPruneCommand, retainedBranchReason } from '../close/retained-branch.ts'
import { FAILS_OVER, failoverRefused } from '../failure/failure.ts'
import { parseMcpProbe } from '../mcp/mcp-probe.ts'
import { failureReason, outcomeOf } from '../outcome.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { classifyRunIdentifier, resolveRunIdentifier } from '../run/run-identifier.ts'
import type { ObservedDeadRun } from '../run/run-liveness.ts'
import { refusalScoreGuidance } from '../score/refusal-guidance.ts'
import {
  observedTestsLine,
  TRUNCATED_TRANSCRIPT_BYTES,
  visibleTranscriptText,
} from './result-output.ts'
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
  if (process.env.BOTTEGA_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT === row.output_path) {
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
  rootId: string
  record_id: string
  agent: string
  status: string
  error: string | null
  failure_kind: string | null
  exit_code: number | null
}
type CollectedRunRow = {
  number: number
  record_id: string
  agent: string
  job: string
  status: string
  latency_ms: number | null
  vendor_tokens: number | null
  output_path: string | null
  error: string | null
  failure_kind: string | null
  exit_code: number | null
  parent_run_record_id: string | null
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
  branch: string | null
  minted_branch: string | null
  tests_ran: number | null
  tests_passed: number | null
  tests_claim_disagrees: number | null
  executor: string
}

type AskingResolution =
  | { state: 'open'; rootId: string }
  | { state: 'running'; rootId: string; runningId: string }
  | { state: 'recoverable'; rootId: string }

function presentObservedTests(
  row: Pick<CollectedRunRow, 'tests_ran' | 'tests_passed' | 'tests_claim_disagrees'>,
  presentation: CollectResultPresentation,
): void {
  const line = observedTestsLine({
    ran: row.tests_ran,
    passed: row.tests_passed,
    claimDisagrees: row.tests_claim_disagrees,
  })
  if (line) presentation.error(line)
}

/** Resolve what an `asking` status means across the whole conversation. */
function resolveAsking(database: Database, runId: string): AskingResolution {
  const member = database
    .query('SELECT record_id, parent_run_record_id FROM run WHERE record_id=?')
    .get(runId) as {
    record_id: string
    parent_run_record_id: string | null
  } | null
  if (!member) throw new Error(`no run ${runId}`)
  const rootId = member.parent_run_record_id ?? member.record_id
  const open = database
    .query(
      `SELECT COUNT(*) n FROM question q JOIN run r ON r.record_id = q.run_record_id
      WHERE (r.record_id = ? OR r.parent_run_record_id = ?) AND ${questionOpenSql('q')}`,
    )
    .get(rootId, rootId) as { n: number }
  if (open.n) return { state: 'open', rootId }

  const running = database
    .query(
      `SELECT record_id FROM run
      WHERE (record_id = ? OR parent_run_record_id = ?) AND status = 'running'
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { record_id: string } | null
  return running
    ? { state: 'running', rootId, runningId: running.record_id }
    : { state: 'recoverable', rootId }
}

/**
 * Whether a failed run can still gain an automatic failover successor.
 *
 * Only these kinds fail over at all, and a recorded refusal is the one durable
 * answer that none will follow — both owned by `failure.ts`. `resolveFailover`'s
 * settling and the run listing's failover watch both ask this here, so neither
 * restates the kinds or the refusal wording to reach its own verdict.
 */
export function mayStillFailOver(row: {
  status: string
  failure_kind: string | null
  error: string | null
}): boolean {
  return (
    row.status === 'failed' &&
    row.failure_kind !== null &&
    (FAILS_OVER as readonly string[]).includes(row.failure_kind) &&
    !failoverRefused(row.error)
  )
}

export type FailoverSuccessor = { record_id: string; number: number; agent: string }

/**
 * The automatic failover successor each of these conversations has claimed, in
 * one read.
 *
 * A successor is anchored on the run it retries rather than on the origin of a
 * chain, because a successor is itself a root that can fail and be succeeded in
 * turn. The lowest-numbered successor wins, which is the one the closing run
 * started first.
 */
export function failoverSuccessors(
  database: Database,
  rootIds: string[],
): Map<string, FailoverSuccessor> {
  const successors = new Map<string, FailoverSuccessor>()
  if (!rootIds.length) return successors
  const marks = rootIds.map(() => '?').join(',')
  const rows = database
    .query<FailoverSuccessor & { root_id: string }, string[]>(
      `SELECT member_root.root_id, successor.record_id, successor.number, successor.agent
         FROM run successor
         JOIN (
           SELECT member.record_id,
                  COALESCE(member.parent_run_record_id, member.record_id) root_id
             FROM run member
            WHERE COALESCE(member.parent_run_record_id, member.record_id) IN (${marks})
         ) member_root ON member_root.record_id = successor.retry_of_record_id
        WHERE successor.automatic_failover = 1
        ORDER BY successor.number`,
    )
    .all(...rootIds)
  for (const row of rows) {
    if (successors.has(row.root_id)) continue
    successors.set(row.root_id, {
      record_id: row.record_id,
      number: row.number,
      agent: row.agent,
    })
  }
  return successors
}

/** Resolve conversation turns backward, then failover successors forward. */
export function resolveFailover(
  database: Database,
  requestedId: string,
): {
  requestedId: string
  attempts: FailoverAttempt[]
  finalId: string
  settling: boolean
} {
  const member = database
    .query('SELECT record_id, parent_run_record_id FROM run WHERE record_id=?')
    .get(requestedId) as { record_id: string; parent_run_record_id: string | null } | null
  if (!member) throw new Error(`no run ${requestedId}`)
  let rootId = member.parent_run_record_id ?? member.record_id
  for (;;) {
    const root = database
      .query('SELECT retry_of_record_id, automatic_failover FROM run WHERE record_id=?')
      .get(rootId) as { retry_of_record_id: string | null; automatic_failover: number }
    if (!root.retry_of_record_id || !root.automatic_failover) break
    const prior = database
      .query('SELECT record_id, parent_run_record_id FROM run WHERE record_id=?')
      .get(root.retry_of_record_id) as {
      record_id: string
      parent_run_record_id: string | null
    } | null
    if (!prior) break
    rootId = prior.parent_run_record_id ?? prior.record_id
  }

  const attempts: FailoverAttempt[] = []
  for (;;) {
    const latest = database
      .query(
        `SELECT record_id, agent, status, error, failure_kind, exit_code
         FROM run WHERE record_id=? OR parent_run_record_id=?
        ORDER BY turn DESC, number DESC LIMIT 1`,
      )
      .get(rootId, rootId) as Omit<FailoverAttempt, 'rootId'>
    attempts.push({ rootId, ...latest })
    const successor = failoverSuccessors(database, [rootId]).get(rootId)
    if (!successor) break
    rootId = successor.record_id
  }
  const last = attempts.at(-1)!
  const pending = database
    .query('SELECT pid, no_failover FROM run WHERE record_id=?')
    .get(last.record_id) as {
    pid: number | null
    no_failover: number
  }
  const workerAlive = pidAlive(pending.pid)
  const settling = mayStillFailOver(last) && !pending.no_failover && workerAlive
  return { requestedId, attempts, finalId: last.record_id, settling }
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
  recordId: string,
  jobName: string,
  parent: string | null,
  scoreSuffix: (job: string) => string,
  refusalGuidance: string | null,
): string {
  const target = parent ?? recordId
  return (
    `${PLATFORM_SLUG} score ${target} <none|partial|full> [wrong|mixed|right]` +
    scoreSuffix(jobName) +
    ' --note "..."' +
    (parent ? `   # the whole conversation, not turn ${recordId}` : '') +
    (refusalGuidance ? `\n  ${refusalGuidance}` : '')
  )
}

function collectedScoreHint(
  row: Pick<CollectedRunRow, 'record_id' | 'job' | 'parent_run_record_id'>,
  output: string | null,
  scoreSuffix: (job: string) => string,
): string {
  return scoreHint(
    row.record_id,
    row.job,
    row.parent_run_record_id,
    scoreSuffix,
    refusalScoreGuidance(output, row.job),
  )
}

function evidenceNote(row: { evidence_excluded: string | null }): string {
  return row.evidence_excluded ? `\n  not routing evidence: ${row.evidence_excluded}` : ''
}

function filedNotesNote(runRecordId: string): string {
  const path = join(resolveRunsDirectory(process.env), runRecordId, 'events.jsonl')
  if (!existsSync(path)) return ''
  const notes = readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as {
          type?: string
          noteLabel?: unknown
          candidates?: unknown
        }
        if (event.type === 'note' && typeof event.noteLabel === 'string') {
          return [
            {
              noteLabel: event.noteLabel,
              candidateLabels: Array.isArray(event.candidates)
                ? event.candidates.flatMap((candidate) =>
                    candidate &&
                    typeof candidate === 'object' &&
                    typeof (candidate as { label?: unknown }).label === 'string'
                      ? [(candidate as { label: string }).label]
                      : [],
                  )
                : [],
            },
          ]
        }
        return []
      } catch {
        return []
      }
    })
  if (!notes.length) return ''
  return `\n  notes:     ${notes
    .map(
      (note) =>
        `${note.noteLabel}${note.candidateLabels.length ? ` (near ${note.candidateLabels.join(', ')})` : ''}`,
    )
    .join('; ')}`
}

/** The branch this turn actually ran on. */
export function mintedBranchForRun(database: Database, runId: string): string | null {
  const run = database
    .query('SELECT branch, minted_branch FROM run WHERE record_id=?')
    .get(runId) as {
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
export function branchNote(database: Database, runId: string): string {
  const branch = mintedBranchForRun(database, runId)
  if (!branch) return ''
  const turn = database
    .query(
      `SELECT record_id, base_commit, branch_kept, branch_kept_tip, changed_paths, prompt_path, repo, launch_key
       FROM run WHERE record_id=?`,
    )
    .get(runId) as
    | (Parameters<typeof noCommitNote>[0] & {
        branch_kept: string | null
        prompt_path: string | null
        repo: string | null
        launch_key: string | null
        record_id: string
      })
    | null
  // Prompts and per-run artifacts share the runs directory; derive it from the
  // row rather than importing the artifact module into the degraded graph.
  const artifacts = turn?.prompt_path ? join(dirname(turn.prompt_path), 'artifacts') : null
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
  runId: string,
): string {
  return facts.writingRun && facts.worktree === null
    ? `\n  open tree:  ${PLATFORM_SLUG} tree open ${runId}`
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
    number: number
    record_id: string
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
        id: row.number,
        record_id: row.record_id,
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

function listResultArtifacts(
  database: Database,
  finalId: string,
  presentation: CollectResultPresentation,
): void {
  const run = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(finalId)
  const dir = run ? join(resolveRunsDirectory(process.env), run.record_id, 'artifacts') : ''
  const files: string[] = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir, { recursive: true })) {
      const path = join(dir, String(name))
      try {
        if (statSync(path).isFile()) files.push(path)
      } catch {
        /* raced */
      }
    }
  }
  if (!files.length) presentation.log('no artifacts')
  else for (const file of files.sort()) presentation.log(file)
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

function presentCollectedOutput(
  row: {
    number: number
    record_id: string
    agent: string
    status: string
    failure_kind: string | null
    exit_code: number | null
    cwd: string | null
  },
  output: string | null,
  ok: boolean,
  presentation: CollectResultPresentation,
): void {
  if (output === null) return
  const runsRoot = resolveRunsDirectory(process.env)
  if (!ok) {
    if (row.failure_kind === 'truncated') {
      presentation.log('TRUNCATED at the output ceiling — this is the transcript, not a result')
      presentation.log(
        utf8Tail(visibleTranscriptText(row.agent, output), TRUNCATED_TRANSCRIPT_BYTES),
      )
      return
    }
    presentation.error(
      `\n— INCOMPLETE partial output from run ${row.record_id} (${row.status}) follows`,
    )
    presentation.log(
      rewriteScratchDirPaths(partialOutputDocument(row, output), row.record_id, runsRoot),
    )
    return
  }
  presentation.log(
    rewriteScratchDirPaths(
      rewriteFilesWrittenPaths(output, (entry) =>
        persistedRunArtifactPath(row.record_id, runsRoot, entry, row.cwd),
      ) ?? output,
      row.record_id,
      runsRoot,
    ),
  )
}

export function collectResult(
  database: Database,
  argv: string[],
  scoreSuffix: (job: string) => string = () => '',
  presentation: CollectResultPresentation = consoleCollectResultPresentation,
  writingJob: (job: string, branch: string | null, mintedBranch: string | null) => boolean = () =>
    false,
): void {
  const unknown = argv.slice(2).find((arg) => arg !== '--quiet' && arg !== '--artifacts')
  if (unknown) {
    throw new Error(
      `unrecognized argument: ${unknown}\nworking form: ${PLATFORM_SLUG} run result <run-id> [--quiet] [--artifacts]`,
    )
  }
  const identifier = argv[1]
  if (!identifier) throw new Error(`${PLATFORM_SLUG} run result <run-id>`)
  const id = resolveRunIdentifier(database, identifier)
  const chain = resolveFailover(database, id)
  const row = database
    .query(
      `SELECT record_id, number, agent, job, status, latency_ms, vendor_tokens, output_path, error,
            failure_kind, exit_code, parent_run_record_id, evidence_excluded, base_commit,
            cwd, mcp, mcp_server, mcp_connected, mcp_error, mcp_probe,
            review_provenance, provenance_status, worktree, branch, minted_branch,
            tests_ran, tests_passed, tests_claim_disagrees, executor
       FROM run WHERE record_id = ?`,
    )
    .get(chain.finalId) as CollectedRunRow | null
  if (!row) throw new Error(`no run ${id}`)
  if (argv.includes('--artifacts')) listResultArtifacts(database, chain.finalId, presentation)
  const asking = row.status === 'asking' ? resolveAsking(database, row.record_id) : null
  const outcome = outcomeOf(row)
  const baseNote = `${row.base_commit ? `\n  base:      ${row.base_commit}` : ''}\n  executor:  ${row.executor}\n  record_id: ${row.record_id}`
  if (!outcome.terminal || chain.settling) {
    presentation.error(`run ${id} (${row.agent}/${row.job}) is still running`)
    presentation.exit(2)
  }
  const replyPath = runScratchReplyPath(row.record_id, resolveRunsDirectory(process.env))
  const output = row.output_path && existsSync(row.output_path)
    ? readFileSync(row.output_path, 'utf8')
    : row.executor === 'harness' && existsSync(replyPath)
      ? readFileSync(replyPath, 'utf8')
      : null
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
  presentCollectedOutput(row, output, outcome.ok, presentation)
  presentObservedTests(row, presentation)
  const chainNote = failoverSummary(chain.attempts)
  if (chainNote) presentation.error(`\n— ${chainNote}`)
  if (asking) {
    presentation.error(
      (asking.state === 'open'
        ? `\n— run ${id} asking — waiting on a ruling: ${PLATFORM_SLUG} question answer ${asking.rootId} ...`
        : asking.state === 'running'
          ? `\n— run ${id} asking — resumed as run ${asking.runningId}, which is still running`
          : `\n— run ${id} asking — recoverable: ${PLATFORM_SLUG} run continue ${asking.rootId}`) +
        baseNote +
        mcpNote(row) +
        filedNotesNote(row.record_id) +
        evidenceNote(row),
    )
    return
  }
  if (!outcome.ok) {
    presentation.error(
      `\n— run ${id} ${row.status}: ${failureReason(row)}` +
        baseNote +
        mcpNote(row) +
        filedNotesNote(row.record_id) +
        evidenceNote(row),
    )
    presentation.exit(1)
  }
  if (!argv.includes('--quiet')) {
    presentation.error(
      `\n— run ${row.number} · ${row.agent} · ${dur(row.latency_ms)}` +
        (row.vendor_tokens !== null
          ? ` · ${row.vendor_tokens.toLocaleString()} vendor tokens`
          : ' · vendor tokens not reported') +
        okOutcomeNote(row) +
        `\n  score it:  ${collectedScoreHint(row, output, scoreSuffix)}` +
        branchNote(database, row.record_id) +
        releasedWritingTreeNote(
          {
            writingRun: writingJob(row.job, row.branch, row.minted_branch),
            worktree: row.worktree,
          },
          row.record_id,
        ) +
        baseNote +
        mcpNote(row) +
        filedNotesNote(row.record_id) +
        evidenceNote(row),
    )
  }
}

const VALUE_FLAGS = new Set(['--timeout'])

export type CollectedWaitRun = {
  requestedId: string
  finalId: string
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
  | { kind: 'timed-out'; runs: CollectedWaitRun[]; runningIds: string[] }

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
  ids: readonly string[],
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
  const observedTerminal = new Set<string>()
  for (;;) {
    const observation = beforePoll()
    const outcomes = ids.map((requestedId) => {
      const chain = resolveFailover(database, requestedId)
      const row = database
        .query(
          'SELECT record_id, status, output_path, error, failure_kind, exit_code FROM run WHERE record_id=?',
        )
        .get(chain.finalId) as {
        record_id: string
        status: string
        output_path: string | null
        error: string | null
        failure_kind: string | null
        exit_code: number | null
      }
      const asking = row.status === 'asking' ? resolveAsking(database, row.record_id) : null
      const outcome =
        asking?.state === 'running'
          ? { terminal: false, ok: false, line: 'running' }
          : asking?.state === 'open'
            ? {
                terminal: true,
                ok: true,
                line: `asking - ${PLATFORM_SLUG} question inbox (or ${PLATFORM_SLUG} question answer ${asking.rootId})`,
              }
            : asking?.state === 'recoverable'
              ? {
                  terminal: true,
                  ok: true,
                  line: `asking - recoverable: ${PLATFORM_SLUG} run continue ${asking.rootId}`,
                }
              : outcomeOf(row)
      return { requestedId, row, chain, outcome }
    })
    if (Array.isArray(observation)) {
      const requestedRows = new Set(outcomes.map(({ row }) => row.record_id))
      for (const dead of observation) {
        if (!requestedRows.has(dead.record_id) || observedTerminal.has(dead.record_id)) continue
        observedTerminal.add(dead.record_id)
        onObservedDead(dead)
      }
    }
    const running = outcomes.filter(
      ({ row, outcome, chain }) =>
        !observedTerminal.has(row.record_id) && (!outcome.terminal || chain.settling),
    )
    const timedOut = now() >= deadline
    if (!running.length || timedOut) {
      const runs = outcomes.map(
        ({ requestedId, row, chain, outcome }): CollectedWaitRun => ({
          requestedId,
          finalId: row.record_id,
          status: row.status,
          output: row.output_path && existsSync(row.output_path) ? readOutput(row.output_path) : '',
          error: row.error,
          exitCode: row.exit_code,
          failureKind: row.failure_kind,
          ok: outcome.ok,
          line: outcome.line,
          attempts: chain.attempts,
          observedDead: observedTerminal.has(row.record_id),
        }),
      )
      if (!running.length) return { kind: 'finished', runs }
      return { kind: 'timed-out', runs, runningIds: running.map(({ row }) => row.record_id) }
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
    if (classifyRunIdentifier(arg)) continue
    if (arg === '--timeout') {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          'argument --timeout needs a value\n' +
            `working form: ${PLATFORM_SLUG} run wait <run-id>... [--timeout SECONDS]`,
        )
      }
      i++
      continue
    }
    throw new Error(
      `unrecognized argument: ${arg}\n` +
        `working form: ${PLATFORM_SLUG} run wait <run-id>... [--timeout SECONDS]`,
    )
  }
  const ids = rest
    .filter((x, i) => classifyRunIdentifier(x) && !VALUE_FLAGS.has(rest[i - 1] ?? ''))
    .map((identifier) => resolveRunIdentifier(database, identifier))
  if (!ids.length) throw new Error(`${PLATFORM_SLUG} run wait <run-id>...`)
  const timeoutAt = argv.indexOf('--timeout')
  const timeoutMs = timeoutAt >= 0 ? Number(argv[timeoutAt + 1]) * 1000 : COLLECT_WAIT_DEFAULT_MS
  const result = await collectWaitForRuns(database, ids, {
    timeoutMs,
    beforePoll,
    onObservedDead: (run) => {
      console.error(
        `run ${run.record_id}: process gone, not terminalised (read-only linked worktree)`,
      )
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
