// concern: session-losses-adapter
/** Gathers loss facts, persists blind candidate files, and dispatches judges. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { resolveStatePaths } from '../../../shared/state-directory.ts'
import { UNJUDGED_OWNER_WINDOW_MS } from '../cleanup/cleanup-sweep-decisions.ts'
import { db } from '../database/db.ts'
import { readTranscriptRows, transcriptSources } from '../metric/transcript-reader.ts'
import { detach } from '../run/run-dispatch.ts'
import {
  type ClaimLifecycle,
  type CursorLifecycle,
  type LifecycleFacts,
  measureSessionLosses,
  type RunLifecycle,
  type SessionLossReport,
  type TranscriptRow,
} from './session-losses.ts'

type JudgeVerdict = {
  candidateId: string
  verdict: 're-asked' | 'contradicted-ruling' | 'neither'
  earlierTurn: string
}
type JudgeState = { runId: string; status: string; verdicts: JudgeVerdict[] | null }
export type SessionLossOutput = SessionLossReport & {
  boundaries: Array<
    SessionLossReport['boundaries'][number] & { candidateFile: string; judge: JudgeState | null }
  >
}

type RunRow = {
  record_id: string
  number: number
  started_at: string
  status: string
  latency_ms: number | null
  parent_run_record_id: string | null
}

function runFacts(sessionId: string): RunLifecycle[] {
  const rows = db()
    .query(
      `SELECT member.record_id,member.number,member.started_at,member.status,member.latency_ms,
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
    const finished = turns.flatMap((turn) =>
      turn.latency_ms === null
        ? []
        : [new Date(Date.parse(turn.started_at) + turn.latency_ms).toISOString()],
    )
    const stoppedAt =
      root.status === 'stopped'
        ? ((
            db()
              .query(
                "SELECT at FROM run_mutation_audit WHERE root_run_record_id=? AND action='stop' ORDER BY at DESC LIMIT 1",
              )
              .get(id) as { at: string } | null
          )?.at ?? null)
        : null
    return {
      id,
      number: root.number,
      startedAt: root.started_at,
      terminalAt: ['ok', 'failed', 'stale', 'stopped'].includes(root.status)
        ? (stoppedAt ?? finished.at(-1) ?? null)
        : null,
    }
  })
}

function cursorFacts(sessionId: string): CursorLifecycle[] {
  const rows = db()
    .query(
      'SELECT record_id,number,created_at,state,closed FROM workflow_cursor WHERE session_id=?',
    )
    .all(sessionId) as Array<{
    record_id: string
    number: number
    created_at: string
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
        row.state === 'done' || row.state === 'abandoned' ? (advancesAt.at(-1) ?? null) : null,
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
  const { runId } = JSON.parse(readFileSync(sidecar, 'utf8')) as { runId: string }
  const row = db().query('SELECT status,output_path FROM run WHERE record_id=?').get(runId) as {
    status: string
    output_path: string | null
  } | null
  if (!row) return { runId, status: 'missing', verdicts: null }
  let verdicts: JudgeVerdict[] | null = null
  if (row.output_path && existsSync(row.output_path)) {
    try {
      verdicts = (JSON.parse(readFileSync(row.output_path, 'utf8')) as { verdicts: JudgeVerdict[] })
        .verdicts
    } catch {}
  }
  return { runId, status: row.status, verdicts }
}

async function dispatchJudge(candidateFile: string, schemaPath: string): Promise<string> {
  return detach(
    'understand',
    `Apply the injected compaction-loss rubric to every candidate in ${candidateFile}. Return one verdict per candidate and cite the earlier turn by timestamp and text.`,
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

async function transcriptRowsBySession(root: string): Promise<Map<string, TranscriptRow[]>> {
  const bySession = new Map<string, TranscriptRow[]>()
  for (const source of transcriptSources(root, 'throw')) {
    const rows = await readTranscriptRows<TranscriptRow>(source)
    const recorded = rows.find((row) => typeof row.sessionId === 'string')?.sessionId
    const sessionId = recorded ?? basename(source.file, '.jsonl')
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), ...rows])
  }
  return bySession
}

async function outputBoundary(
  boundary: SessionLossReport['boundaries'][number],
  sessionId: string,
  directory: string,
  schemaPath: string,
  shouldJudge: boolean,
): Promise<SessionLossOutput['boundaries'][number]> {
  const candidateFile = join(directory, `${sessionId}-${Date.parse(boundary.at)}.json`)
  writeFileSync(candidateFile, `${JSON.stringify(boundary.candidates, null, 2)}\n`, { mode: 0o600 })
  const sidecar = `${candidateFile}.judge.json`
  let judge = foldedJudge(sidecar)
  if (shouldJudge && boundary.candidates.candidates.length && !judge) {
    const runId = await dispatchJudge(candidateFile, schemaPath)
    writeFileSync(sidecar, `${JSON.stringify({ runId }, null, 2)}\n`, { mode: 0o600 })
    judge = { runId, status: 'running', verdicts: null }
  }
  return { ...boundary, candidateFile, judge }
}

const rowsSince = (rows: TranscriptRow[], since: number | null) =>
  since === null
    ? rows
    : rows.filter(
        (row) =>
          Number.isFinite(Date.parse(row.timestamp ?? '')) && Date.parse(row.timestamp!) >= since,
      )

export async function sessionLosses(input: LossInput): Promise<SessionLossOutput[]> {
  const since = validatedSince(input)
  const root = readMachineValue('hub.transcript_root')
  if (!root) throw new Error('cannot read transcript directory hub.transcript_root: path is empty')
  const bySession = await transcriptRowsBySession(root)
  for (const sessionId of input.sessions)
    if (!bySession.has(sessionId))
      throw new Error(`named session ${sessionId} has no transcript under ${root}`)

  const selected = input.all
    ? [...bySession.entries()]
    : input.sessions.map((id) => [id, bySession.get(id)!] as const)
  const directory = stateDirectory()
  const schemaPath = join(directory, 'judge-schema.json')
  writeFileSync(schemaPath, `${JSON.stringify(judgeSchema, null, 2)}\n`, { mode: 0o600 })
  const output: SessionLossOutput[] = []
  for (const [sessionId, allRows] of selected) {
    const report = measureSessionLosses(sessionId, rowsSince(allRows, since), factsFor(sessionId))
    if (!report) continue
    const boundaries = await Promise.all(
      report.boundaries.map((boundary) =>
        outputBoundary(boundary, sessionId, directory, schemaPath, input.judge),
      ),
    )
    output.push({ ...report, boundaries })
  }
  return output
}
