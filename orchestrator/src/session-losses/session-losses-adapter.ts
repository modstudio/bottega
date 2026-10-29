// concern: session-losses-adapter
/** Gathers loss facts, persists blind candidate files, and dispatches judges. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { resolveStatePaths } from '../../../shared/state-directory.ts'
import { UNJUDGED_OWNER_WINDOW_MS } from '../cleanup/cleanup-sweep-decisions.ts'
import { REPLY_FILE_NAME } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { getDoc } from '../doc/docs.ts'
import {
  readTranscriptRows,
  readTranscriptSessionId,
  transcriptSources,
} from '../metric/transcript-reader.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { detach } from '../run/run-dispatch.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import {
  type ClaimLifecycle,
  type CursorLifecycle,
  hasTranscriptRowTime,
  type LifecycleFacts,
  measureSessionLosses,
  type RunLifecycle,
  type SessionLossReport,
  type TranscriptRow,
  transcriptRowTime,
} from './session-losses.ts'

type JudgeVerdict = {
  candidateId: string
  verdict: 're-asked' | 'contradicted-ruling' | 'neither'
  earlierTurn: string
}
type JudgeState = {
  runId: string | null
  status: string
  verdicts: JudgeVerdict[] | null
  rubricRevision: string | null
  error?: string
}
type SessionLossOutput = Omit<SessionLossReport, 'boundaries'> & {
  boundaries: Array<
    Omit<SessionLossReport['boundaries'][number], 'candidates'> & {
      candidateFile: string
      candidateCount: number
      judge: JudgeState | null
    }
  >
}
type SessionLossFailure = { sessionId: string; error: 'no timestamped rows' }
export type SessionLossResult = SessionLossOutput | SessionLossFailure

type RunRow = {
  record_id: string
  number: number
  started_at: string
  status: string
  latency_ms: number | null
  last_event_at: string | null
  parent_run_record_id: string | null
}

function runFacts(sessionId: string): RunLifecycle[] {
  const rows = db()
    .query(
      `SELECT member.record_id,member.number,member.started_at,member.status,member.latency_ms,
              member.last_event_at,
              member.parent_run_record_id
         FROM run root JOIN run member
           ON member.record_id=root.record_id OR member.parent_run_record_id=root.record_id
        WHERE root.parent_run_record_id IS NULL AND root.session_id=?
        ORDER BY member.started_at,member.number`,
    )
    .all(sessionId) as RunRow[]
  const chains = new Map<string, RunRow[]>()
  for (const row of rows) {
    const root = row.parent_run_record_id ?? row.record_id
    chains.set(root, [...(chains.get(root) ?? []), row])
  }
  return [...chains.entries()].map(([id, turns]) => {
    const root = turns.find((turn) => turn.record_id === id)!
    const lastTurn = turns.at(-1)!
    const latencyAt =
      lastTurn.latency_ms === null
        ? null
        : new Date(Date.parse(lastTurn.started_at) + lastTurn.latency_ms).toISOString()
    const stoppedAt =
      (
        db()
          .query(
            "SELECT at FROM run_mutation_audit WHERE root_run_record_id=? AND action='stop' ORDER BY at DESC LIMIT 1",
          )
          .get(id) as { at: string } | null
      )?.at ?? null
    return {
      id,
      number: root.number,
      startedAt: root.started_at,
      terminalAt: TERMINAL_RUN_STATUS_SET.has(root.status)
        ? (stoppedAt ?? latencyAt ?? lastTurn.last_event_at ?? lastTurn.started_at)
        : null,
    }
  })
}

function cursorFacts(sessionId: string): CursorLifecycle[] {
  const rows = db()
    .query(
      'SELECT record_id,number,created_at,updated_at,state,closed FROM workflow_cursor WHERE session_id=?',
    )
    .all(sessionId) as Array<{
    record_id: string
    number: number
    created_at: string
    updated_at: string
    state: string
    closed: string
  }>
  return rows.map((row) => {
    const advancesAt = (JSON.parse(row.closed) as Array<{ at?: unknown }>).flatMap((entry) =>
      typeof entry.at === 'string' ? [entry.at] : [],
    )
    return {
      id: row.record_id,
      number: row.number,
      createdAt: row.created_at,
      terminalAt:
        row.state === 'done' || row.state === 'abandoned'
          ? (advancesAt.at(-1) ?? row.updated_at)
          : null,
      advancesAt,
    }
  })
}

function claimFacts(sessionId: string): ClaimLifecycle[] {
  return (
    db()
      .query(
        `SELECT record_id,subject_kind,subject_value,taken_at,closed_at
           FROM board_claim WHERE holder_session=?`,
      )
      .all(sessionId) as Array<{
      record_id: string
      subject_kind: string
      subject_value: string
      taken_at: string
      closed_at: string | null
    }>
  ).map((row) => ({
    id: row.record_id,
    subject: row.subject_value,
    takenAt: row.taken_at,
    closedAt: row.closed_at,
  }))
}

function factsFor(sessionId: string): LifecycleFacts {
  return {
    runs: runFacts(sessionId),
    cursors: cursorFacts(sessionId),
    claims: claimFacts(sessionId),
    unjudgedOwnerWindowMs: UNJUDGED_OWNER_WINDOW_MS,
  }
}

function stateDirectory(): string {
  const directory = join(resolveStatePaths(process.env).orchestratorDirectory, 'session-losses')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

const judgeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'verdict', 'earlierTurn'],
        properties: {
          candidateId: { type: 'string' },
          verdict: { enum: ['re-asked', 'contradicted-ruling', 'neither'] },
          earlierTurn: { type: 'string' },
        },
      },
    },
  },
}

function foldedJudge(sidecar: string): JudgeState | null {
  if (!existsSync(sidecar)) return null
  const { runId, rubricRevision } = JSON.parse(readFileSync(sidecar, 'utf8')) as {
    runId: string
    rubricRevision?: string
  }
  if (!rubricRevision)
    return {
      runId,
      status: 'rubric-unrecorded',
      verdicts: null,
      rubricRevision: null,
    }
  const row = db().query('SELECT status FROM run WHERE record_id=?').get(runId) as {
    status: string
  } | null
  if (!row) return { runId, status: 'missing', verdicts: null, rubricRevision }
  if (!TERMINAL_RUN_STATUS_SET.has(row.status))
    return { runId, status: row.status, verdicts: null, rubricRevision }
  return { runId, rubricRevision, ...judgeReply(runId, row.status) }
}

/** Reads the judge's schema-bound reply file; the run's output text may carry harness notices. */
function judgeReply(
  runId: string,
  status: string,
): Pick<JudgeState, 'status' | 'verdicts' | 'error'> {
  const paths = [runArtifactsDir(runId), runScratchDir(runId)].map((dir) =>
    join(dir, REPLY_FILE_NAME),
  )
  const path = paths.find((candidate) => existsSync(candidate))
  if (!path)
    return { status: 'reply-missing', verdicts: null, error: `no reply at ${paths.join(' or ')}` }
  try {
    const { verdicts } = JSON.parse(readFileSync(path, 'utf8')) as { verdicts?: unknown }
    if (!Array.isArray(verdicts)) throw new Error('no verdicts array')
    return { status, verdicts: verdicts as JudgeVerdict[] }
  } catch (error) {
    return {
      status: 'reply-unreadable',
      verdicts: null,
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

type JudgeRubric = { body: string; revision: string }

const rubricSetCommand =
  `${PLATFORM_SLUG} doc set compaction-loss-rubric --scope job --subject understand ` +
  '--title "Compaction loss rubric" --reason "establish DEV-1854 judge rubric" ' +
  '--delivery demand --file <rubric.md>'

function judgeRubric(): JudgeRubric {
  const doc = getDoc('job', 'understand', 'compaction-loss-rubric')
  if (doc?.status !== 'current' || doc.delivery !== 'demand' || !doc.revision)
    throw new Error(
      `compaction-loss judge rubric job/understand/compaction-loss-rubric is absent, not current, or not demand-delivered; set it with: ${rubricSetCommand}`,
    )
  return { body: doc.body, revision: doc.revision }
}

async function dispatchJudge(
  candidateFile: string,
  schemaPath: string,
  rubric: JudgeRubric,
): Promise<string> {
  return detach(
    'understand',
    `Compaction-loss rubric (revision ${rubric.revision}):\n\n${rubric.body}\n\nCandidate file: ${candidateFile}\n\nApply the rubric to every candidate. Return one verdict per candidate and cite the earlier turn by timestamp and text.`,
    { cwd: process.cwd(), schema: schemaPath, label: 'compaction-loss judge' },
  )
}

type LossInput = { sessions: string[]; all: boolean; since?: string; judge: boolean }

function validatedSince(input: LossInput): number | null {
  if (!input.all && input.sessions.length === 0)
    throw new Error('select transcripts with --session <id> (repeatable) or --all')
  if (input.all && input.sessions.length)
    throw new Error('--session and --all are mutually exclusive')
  const since = input.since === undefined ? null : Date.parse(input.since)
  if (input.since !== undefined && !Number.isFinite(since))
    throw new Error(`--since must be an ISO date; got ${input.since}`)
  return since
}

type Source = ReturnType<typeof transcriptSources>[number]

async function transcriptRowsForSession(
  sessionId: string,
  sources: Source[],
): Promise<TranscriptRow[]> {
  const allRows: TranscriptRow[] = []
  for (const source of sources) {
    const rows = await readTranscriptRows<TranscriptRow>(source)
    const recorded = rows.find((row) => typeof row.sessionId === 'string')?.sessionId
    if (recorded && recorded !== sessionId)
      throw new Error(
        `transcript ${source.file} is named for session ${sessionId} but its first sessionId row is ${recorded}`,
      )
    allRows.push(...rows)
  }
  return allRows
}

async function sourcesBySession(root: string, selectedIds: string[] | null) {
  const sources = transcriptSources(root, 'throw')
  const selected = selectedIds ? new Set(selectedIds) : null
  const bySession = new Map<string, Source[]>()
  for (const source of sources) {
    const sessionId = basename(source.file, '.jsonl')
    if (selected && !selected.has(sessionId)) continue
    const recorded = await readTranscriptSessionId(source)
    if (recorded !== sessionId) continue
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), source])
  }
  return bySession
}

async function outputBoundary(
  boundary: SessionLossReport['boundaries'][number],
  sessionId: string,
  directory: string,
  schemaPath: string,
  rubric: JudgeRubric | null,
): Promise<SessionLossOutput['boundaries'][number]> {
  const candidateFile = join(directory, `${sessionId}-${Date.parse(boundary.at)}.json`)
  writeFileSync(candidateFile, `${JSON.stringify(boundary.candidates, null, 2)}\n`, { mode: 0o600 })
  const sidecar = `${candidateFile}.judge.json`
  let judge = foldedJudge(sidecar)
  if (
    rubric &&
    boundary.candidates.candidates.length &&
    (!judge || judge.status === 'rubric-unrecorded')
  ) {
    try {
      const runId = await dispatchJudge(candidateFile, schemaPath, rubric)
      writeFileSync(
        sidecar,
        `${JSON.stringify({ runId, rubricRevision: rubric.revision }, null, 2)}\n`,
        { mode: 0o600 },
      )
      judge = {
        runId,
        status: 'running',
        verdicts: null,
        rubricRevision: rubric.revision,
      }
    } catch (error) {
      judge = {
        runId: null,
        status: 'dispatch-failed',
        verdicts: null,
        rubricRevision: rubric.revision,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const { candidates, ...mechanical } = boundary
  return {
    ...mechanical,
    candidateFile,
    candidateCount: candidates.candidates.length,
    judge,
  }
}

const rowsSince = (rows: TranscriptRow[], since: number | null) =>
  since === null
    ? rows
    : rows.filter((row) => hasTranscriptRowTime(row) && transcriptRowTime(row) >= since)

async function outputSession(
  sessionId: string,
  sources: Source[],
  since: number | null,
  directory: string,
  schemaPath: string,
  rubric: JudgeRubric | null,
): Promise<SessionLossResult> {
  const allRows = await transcriptRowsForSession(sessionId, sources)
  const report = measureSessionLosses(sessionId, rowsSince(allRows, since), factsFor(sessionId))
  if (!report) return { sessionId, error: 'no timestamped rows' }
  const boundaries: SessionLossOutput['boundaries'] = []
  for (const boundary of report.boundaries)
    boundaries.push(await outputBoundary(boundary, sessionId, directory, schemaPath, rubric))
  return { ...report, boundaries }
}

export async function sessionLosses(input: LossInput): Promise<SessionLossResult[]> {
  const since = validatedSince(input)
  const root = readMachineValue('hub.transcript_root')
  if (!root) throw new Error('cannot read transcript directory hub.transcript_root: path is empty')
  const bySession = await sourcesBySession(root, input.all ? null : input.sessions)
  for (const sessionId of input.sessions) {
    if (!bySession.has(sessionId))
      throw new Error(`named session ${sessionId} has no transcript under ${root}`)
  }

  const selected = input.all
    ? [...bySession.entries()]
    : input.sessions.map((id) => [id, bySession.get(id)!] as const)
  const rubric = input.judge ? judgeRubric() : null
  const directory = stateDirectory()
  const schemaPath = join(directory, 'judge-schema.json')
  writeFileSync(schemaPath, `${JSON.stringify(judgeSchema, null, 2)}\n`, { mode: 0o600 })
  const output: SessionLossResult[] = []
  for (const [sessionId, sessionSources] of selected)
    output.push(
      await outputSession(sessionId, sessionSources, since, directory, schemaPath, rubric),
    )
  return output
}
