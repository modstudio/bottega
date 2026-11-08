// concern: note-duplicate-backtest
/** Replays note-duplicate versions over ruled note pairs and measures tuning and holdout sets. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  type TypedQuestionMetricRow,
  typedQuestionMetrics,
} from '../../shared/typed-question/typed-question-metrics.ts'
import { db } from './db.ts'
import {
  NOTE_DUPLICATE_QUESTION,
  NOTE_PAIR_SUBJECT_KIND,
  noteDuplicateGoverningOutcome,
  noteTextHash,
  parseNotePairSubjectRef,
} from './note-duplicate-question.ts'
import { TYPED_QUESTION_DECLARATIONS } from './typed-question-declarations.ts'
import { askHubTypedQuestion } from './typed-question-service.ts'

const NOTE_DUPLICATE_HOLDOUT_SHARE = 0.2
const NOTE_DUPLICATE_SWEEP_THRESHOLDS = Array.from(
  { length: 10 },
  (_, index) => (50 + index * 5) / 100,
)

type PairState = { existing: string; new: string }
type Subject = { subjectRef: string; state: PairState; label: boolean; source: string }

export function noteDuplicateHoldout(subjectRef: string): boolean {
  return createHash('sha256').update(subjectRef).digest()[0]! < NOTE_DUPLICATE_HOLDOUT_SHARE * 256
}

function parsedState(value: string | null): PairState | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as Partial<PairState>
    return typeof parsed.existing === 'string' && typeof parsed.new === 'string'
      ? { existing: parsed.existing, new: parsed.new }
      : null
  } catch {
    return null
  }
}

export function reconstructNotePairState(database: Database, subjectRef: string): PairState | null {
  const parsed = parseNotePairSubjectRef(subjectRef)
  if (!parsed) return null
  const { existingId, hash } = parsed
  const existing = database
    .query<{ project: string; text: string }, [string]>(
      'SELECT project,text FROM note WHERE record_id=?',
    )
    .get(existingId)
  if (!existing) return null
  const newer = database
    .query<{ text: string }, [string, string]>(
      'SELECT text FROM note WHERE project=? AND record_id<>? ORDER BY created_at,record_id',
    )
    .all(existing.project, existingId)
    .find((note) => noteTextHash(note.text) === hash)
  return newer ? { existing: existing.text, new: newer.text } : null
}

function subjects(database: Database): { readable: Subject[]; unreadable: number } {
  const refs = database
    .query<{ subject_ref: string }, [string, number]>(
      `SELECT DISTINCT subject_ref FROM typed_question_outcome
       WHERE question_id=? AND question_version=?`,
    )
    .all(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version)
  const readable: Subject[] = []
  let unreadable = 0
  for (const { subject_ref: subjectRef } of refs) {
    const outcome = noteDuplicateGoverningOutcome(database, subjectRef)
    if (!outcome) continue
    const stored = database
      .query<{ state_json: string | null }, [string, string]>(
        `SELECT state_json FROM typed_question_answer WHERE question_id=? AND subject_ref=?
         AND state_json IS NOT NULL ORDER BY created_at DESC,record_id DESC LIMIT 1`,
      )
      .get(NOTE_DUPLICATE_QUESTION.id, subjectRef)
    const state =
      parsedState(stored?.state_json ?? null) ?? reconstructNotePairState(database, subjectRef)
    if (!state) unreadable += 1
    else readable.push({ subjectRef, state, label: outcome.label, source: outcome.source })
  }
  return { readable, unreadable }
}

function answerRow(
  database: Database,
  version: number,
  subject: Subject,
): TypedQuestionMetricRow | null {
  const row = database
    .query<
      {
        answer_json: string | null
        error: string | null
        latency_ms: number
        input_tokens: number | null
      },
      [string, number, string]
    >(
      `SELECT answer_json,error,latency_ms,input_tokens FROM typed_question_answer
       WHERE question_id=? AND question_version=? AND subject_ref=?
       ORDER BY created_at DESC,record_id DESC LIMIT 1`,
    )
    .get(NOTE_DUPLICATE_QUESTION.id, version, subject.subjectRef)
  if (!row) return null
  let probability: number | null = null
  try {
    const parsed = JSON.parse(row.answer_json ?? 'null') as { noul?: unknown } | null
    if (typeof parsed?.noul === 'number') probability = parsed.noul
  } catch {}
  return {
    probability,
    label: subject.label,
    error: row.error,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
  }
}

export function noteDuplicateSweep(rows: readonly TypedQuestionMetricRow[]) {
  return NOTE_DUPLICATE_SWEEP_THRESHOLDS.map((threshold) => {
    const metrics = typedQuestionMetrics(rows, threshold)
    return {
      threshold,
      precision: metrics.precision,
      recall: metrics.recall,
      warnedRate: metrics.warnedRate,
    }
  })
}

export async function noteDuplicateBacktest(
  version: number,
  database: Database = db(),
  ask = askHubTypedQuestion,
): Promise<{
  readable: number
  unreadable: number
  unanswered: number
  labelSources: Record<string, number>
  sweep: ReturnType<typeof noteDuplicateSweep>
  threshold: number
  heldOut: ReturnType<typeof typedQuestionMetrics>
}> {
  const question = TYPED_QUESTION_DECLARATIONS.find(
    (candidate) => candidate.id === NOTE_DUPLICATE_QUESTION.id && candidate.version === version,
  )
  if (!question) throw new Error(`note_duplicate v${version} is not declared`)
  const sourced = subjects(database)
  for (const subject of sourced.readable) {
    if (!answerRow(database, version, subject))
      await ask({
        question,
        subjectKind: NOTE_PAIR_SUBJECT_KIND,
        subjectRef: subject.subjectRef,
        state: subject.state,
      })
  }
  const subjectRows = sourced.readable.map((subject) => ({
    subject,
    row: answerRow(database, version, subject),
  }))
  const unanswered = subjectRows.filter(
    ({ row }) => !row || row.error !== null || row.probability === null,
  ).length
  const rows = subjectRows.filter(
    (item): item is typeof item & { row: TypedQuestionMetricRow } => item.row !== null,
  )
  const tuning = rows
    .filter(({ subject }) => !noteDuplicateHoldout(subject.subjectRef))
    .map(({ row }) => row)
  const heldOut = rows
    .filter(({ subject }) => noteDuplicateHoldout(subject.subjectRef))
    .map(({ row }) => row)
  const labelSources: Record<string, number> = {}
  for (const subject of sourced.readable)
    labelSources[subject.source] = (labelSources[subject.source] ?? 0) + 1
  return {
    readable: sourced.readable.length,
    unreadable: sourced.unreadable,
    unanswered,
    labelSources,
    sweep: noteDuplicateSweep(tuning),
    threshold: question.threshold,
    heldOut: typedQuestionMetrics(heldOut, question.threshold),
  }
}
