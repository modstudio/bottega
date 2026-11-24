// concern: session-losses-adapter
/** Gathers loss facts, persists blind candidate files, and dispatches judges. */

import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { resolveStatePaths } from '../../../shared/state-directory.ts'
import { boardClaimsOfSession } from '../board/board-operations.ts'
import { UNJUDGED_OWNER_WINDOW_MS } from '../cleanup/cleanup-sweep-decisions.ts'
import { REPLY_FILE_NAME } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { listContextItems } from '../doc/context-item-store.ts'
import { readDoc } from '../doc/doc-authoritative-read.ts'
import {
  readTranscriptRows,
  readTranscriptSessionId,
  transcriptSources,
} from '../metric/transcript-reader.ts'
import { isClosedStageState } from '../record/record-task-flow-contract.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { detach } from '../run/run-dispatch.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { decodeReviewItemRefs } from '../session/context-review-store.ts'
import { localTaskReferencesForSession, taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  type ClaimLifecycle,
  type ContextReviewLoss,
  type ContextReviewLossRow,
  type CursorLifecycle,
  compactionCaptureSource,
  hasTranscriptRowTime,
  type LifecycleFacts,
  measureContextReviewLosses,
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
  reviews: ContextReviewLoss[]
  boundaries: Array<
    Omit<SessionLossReport['boundaries'][number], 'candidates'> & {
      brief: BriefInjectionSummary | null
      candidateFile: string
      candidateCount: number
      judge: JudgeState | null
      captured: number
    }
  >
}

export async function contextReviewMeasurements(
  sessionId: string,
  boundaries: SessionLossReport['boundaries'],
  dependencies: {
    database?: Database
    readItems?: typeof listContextItems
  } = {},
) {
  const database = dependencies.database ?? db()
  const rows = database
    .query<{ at: string; items: number; flagged: number; item_ids: string }, [string]>(
      `SELECT at,items,flagged,item_ids FROM context_review
       WHERE session_id=? ORDER BY at,record_id`,
    )
    .all(sessionId)
  const storedItems = rows.map((row) => decodeReviewItemRefs(row.item_ids))
  const reviews = rows.map(
    (row, index): ContextReviewLossRow => ({
      at: row.at,
      items: row.items,
      flagged: row.flagged,
      itemIds: storedItems[index]!.map((item) => (typeof item === 'string' ? item : item.id)),
    }),
  )
  const reviewedIds = new Set(reviews.flatMap((review) => review.itemIds))
  const captureSource = compactionCaptureSource(sessionId)
  const taskFacts = [
    ...database
      .query<{ task_record_id: string; project: string }, [string]>(
        `SELECT DISTINCT run.task_record_id,project.name project FROM run
         JOIN project ON project.record_id=run.project_record_id
         WHERE run.session_id=? AND run.task_record_id IS NOT NULL`,
      )
      .all(sessionId),
    ...(await localTaskReferencesForSession(database, sessionId)).map((row) => ({
      task_record_id: row.recordId,
      project: row.project,
    })),
  ]
  const ownerByHolder = new Map(
    taskFacts.map((fact) => [
      `task:${fact.task_record_id}`,
      { kind: 'task' as const, projectName: fact.project },
    ]),
  )
  const taskHolders = [...ownerByHolder].map(([holder, owner]) => ({ holder, owner }))
  const holders = [
    `session:${sessionId}`,
    ...taskHolders,
    ...storedItems.flatMap((items) =>
      items.flatMap((item) => {
        if (typeof item === 'string') return []
        const owner = ownerByHolder.get(item.holder)
        return [owner ? { holder: item.holder, owner } : item.holder]
      }),
    ),
  ]
  const uniqueHolders = [
    ...new Map(
      holders.map((entry) => [typeof entry === 'string' ? entry : entry.holder, entry]),
    ).values(),
  ]
  const items = (await (dependencies.readItems ?? listContextItems)(uniqueHolders))
    .map((item) => ({
      id: item.recordId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      source: item.source,
    }))
    .filter((item) => reviewedIds.has(item.id) || item.source === captureSource)
  return measureContextReviewLosses(
    reviews,
    items,
    boundaries.map((boundary) => boundary.at),
    captureSource,
  )
}
export type BriefInjectionSummary = {
  bytes: number
  lines: number
  overCap: boolean
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

async function cursorFacts(sessionId: string): Promise<CursorLifecycle[]> {
  const rows = await taskFlowReadStore(db()).cursorLifecycleForSession(sessionId)
  return rows.map((row) => {
    const advancesAt = (JSON.parse(row.closed) as Array<{ at?: unknown }>).flatMap((entry) =>
      typeof entry.at === 'string' ? [entry.at] : [],
    )
    return {
      id: row.record_id,
      number: row.number,
      createdAt: row.created_at,
      terminalAt: isClosedStageState(row.state) ? (advancesAt.at(-1) ?? row.updated_at) : null,
      advancesAt,
    }
  })
}

async function claimFacts(sessionId: string): Promise<ClaimLifecycle[]> {
  return (await boardClaimsOfSession(sessionId, true)).map((claim) => ({
    id: claim.recordId,
    subject: claim.subject.value,
    takenAt: claim.takenAt,
    closedAt: claim.closedAt,
  }))
}

async function factsFor(sessionId: string): Promise<LifecycleFacts> {
  return {
    runs: runFacts(sessionId),
    cursors: await cursorFacts(sessionId),
    claims: await claimFacts(sessionId),
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

async function judgeRubric(): Promise<JudgeRubric> {
  const doc = await readDoc('job', 'understand', 'compaction-loss-rubric')
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
  brief: BriefInjectionSummary | null,
  sessionId: string,
  directory: string,
  schemaPath: string,
  rubric: JudgeRubric | null,
): Promise<Omit<SessionLossOutput['boundaries'][number], 'captured'>> {
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
    brief,
    candidateFile,
    candidateCount: candidates.candidates.length,
    judge,
  }
}

export type BriefInjectionRow = {
  at: string
  bytes: number
  lines: number
  over_cap: number
}

export function briefsAtBoundaries(
  boundaryAts: readonly string[],
  injections: readonly BriefInjectionRow[],
): Array<BriefInjectionSummary | null> {
  return boundaryAts.map((boundaryAt, index) => {
    const start = Date.parse(boundaryAt)
    const end = Date.parse(boundaryAts[index + 1] ?? '9999-12-31T23:59:59.999Z')
    const row = injections.find((candidate) => {
      const at = Date.parse(candidate.at)
      return at >= start && at < end
    })
    return row ? { bytes: row.bytes, lines: row.lines, overCap: Boolean(row.over_cap) } : null
  })
}

function briefsForBoundaries(
  sessionId: string,
  boundaries: SessionLossReport['boundaries'],
): Array<BriefInjectionSummary | null> {
  const injections = db()
    .query<BriefInjectionRow, [string]>(
      `SELECT at,bytes,lines,over_cap FROM brief_injection
       WHERE session_id=? AND source='compact' ORDER BY at,record_id`,
    )
    .all(sessionId)
  return briefsAtBoundaries(
    boundaries.map((boundary) => boundary.at),
    injections,
  )
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
  const report = measureSessionLosses(
    sessionId,
    rowsSince(allRows, since),
    await factsFor(sessionId),
  )
  if (!report) return { sessionId, error: 'no timestamped rows' }
  const briefs = briefsForBoundaries(sessionId, report.boundaries)
  const reviewMeasurements = await contextReviewMeasurements(sessionId, report.boundaries)
  const boundaries: SessionLossOutput['boundaries'] = []
  for (const [index, boundary] of report.boundaries.entries())
    boundaries.push({
      ...(await outputBoundary(boundary, briefs[index]!, sessionId, directory, schemaPath, rubric)),
      captured: reviewMeasurements.captured[index]!,
    })
  return { ...report, reviews: reviewMeasurements.reviews, boundaries }
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
  const rubric = input.judge ? await judgeRubric() : null
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
