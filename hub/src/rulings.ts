import { db } from './db.ts'

const RULINGS_STALE_AFTER_KEY = 'rulings.stale_after'
const RULINGS_STALE_AFTER_DEFAULT = '1h'

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function durationMs(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)([smhd])$/)
  return match ? Math.round(Number(match[1]) * UNITS[match[2]!]!) : null
}

const DEFAULT_STATS_DAYS = 14
const FIVE_MINUTES_MS = 5 * 60_000
const ONE_HOUR_MS = 60 * 60_000

export type RulingMeasureQuestion = {
  question_id: number
  asked_at: string
  answered_at: string | null
  asked_via: 'live' | 'reply' | null
  answerer_kind: 'agent' | 'operator' | 'eval' | null
}

export type RulingMeasureDelivery = {
  question_id: number
  mode: 'live' | 'resume' | 'retry' | 'record-only'
  outcome: 'delivered' | 'failed'
}

type WaitSummary = {
  count: number
  median_ms: number | null
  p90_ms: number | null
  under_5_minutes: number
  under_1_hour: number
  over_1_hour: number
}

function percentile(sorted: number[], percentage: number): number | null {
  if (!sorted.length) return null
  if (percentage === 0.5 && sorted.length % 2 === 0) {
    const upper = sorted.length / 2
    return (sorted[upper - 1]! + sorted[upper]!) / 2
  }
  return sorted[Math.ceil(sorted.length * percentage) - 1]!
}

function summarizeWaits(waits: number[]): WaitSummary {
  const sorted = waits.toSorted((left, right) => left - right)
  return {
    count: sorted.length,
    median_ms: percentile(sorted, 0.5),
    p90_ms: percentile(sorted, 0.9),
    under_5_minutes: sorted.filter((wait) => wait < FIVE_MINUTES_MS).length,
    under_1_hour: sorted.filter((wait) => wait < ONE_HOUR_MS).length,
    over_1_hour: sorted.filter((wait) => wait > ONE_HOUR_MS).length,
  }
}

export function measureRulings(
  questionRows: RulingMeasureQuestion[],
  deliveryRows: RulingMeasureDelivery[],
  options: { now?: number; days?: number; staleAfterMs?: number } = {},
) {
  const now = options.now ?? Date.now()
  const days = options.days ?? DEFAULT_STATS_DAYS
  const staleAfterMs = options.staleAfterMs ?? ONE_HOUR_MS
  const startsAt = now - days * 86_400_000
  const questions = questionRows.filter((question) => {
    const askedAt = Date.parse(question.asked_at)
    return Number.isFinite(askedAt) && askedAt >= startsAt && askedAt <= now
  })
  const questionIds = new Set(questions.map((question) => question.question_id))
  const deliveries = deliveryRows.filter((delivery) => questionIds.has(delivery.question_id))
  const waits = questions.flatMap((question) => {
    if (question.answered_at == null) return []
    const wait = Date.parse(question.answered_at) - Date.parse(question.asked_at)
    return Number.isFinite(wait) && wait >= 0 ? [{ kind: question.answerer_kind, wait }] : []
  })
  const kinds = ['agent', 'operator', 'eval'] as const
  const modes = ['live', 'resume', 'retry', 'record-only'] as const
  const outcomes = Object.fromEntries(
    modes.map((mode) => [
      mode,
      {
        delivered: deliveries.filter(
          (delivery) => delivery.mode === mode && delivery.outcome === 'delivered',
        ).length,
        failed: deliveries.filter(
          (delivery) => delivery.mode === mode && delivery.outcome === 'failed',
        ).length,
      },
    ]),
  ) as Record<(typeof modes)[number], { delivered: number; failed: number }>
  const stoppedQuestions = questions.filter((question) => question.asked_via === 'reply')
  const deliveredByResume = stoppedQuestions.filter((question) =>
    deliveries.some(
      (delivery) =>
        delivery.question_id === question.question_id &&
        delivery.mode === 'resume' &&
        delivery.outcome === 'delivered',
    ),
  ).length
  const deliveredByRetry = stoppedQuestions.filter((question) =>
    deliveries.some(
      (delivery) =>
        delivery.question_id === question.question_id &&
        delivery.mode === 'retry' &&
        delivery.outcome === 'delivered',
    ),
  ).length
  const stoppedDelivered = deliveredByResume + deliveredByRetry
  const open = questions.filter((question) => question.answered_at == null)
  const operatorWaits = waits.filter((item) => item.kind === 'operator').map((item) => item.wait)
  const waitsFor = (kind: (typeof kinds)[number] | null) =>
    summarizeWaits(waits.filter((item) => item.kind === kind).map((item) => item.wait))
  const byAnswererKind = {
    agent: waitsFor('agent'),
    operator: waitsFor('operator'),
    eval: waitsFor('eval'),
    unknown: waitsFor(null),
  }

  return {
    window: {
      days,
      starts_at: new Date(startsAt).toISOString(),
      ends_at: new Date(now).toISOString(),
    },
    questions_asked: {
      total: questions.length,
      by_asked_via: {
        live: questions.filter((question) => question.asked_via === 'live').length,
        reply: stoppedQuestions.length,
        unknown: questions.filter((question) => question.asked_via == null).length,
      },
    },
    answer_wait: {
      overall: summarizeWaits(waits.map((item) => item.wait)),
      by_answerer_kind: byAnswererKind,
    },
    delivery: {
      by_mode_and_outcome: outcomes,
      stopped_turn: {
        delivered: stoppedDelivered,
        resume: deliveredByResume,
        retry: deliveredByRetry,
        resume_share: stoppedDelivered ? deliveredByResume / stoppedDelivered : null,
        retry_share: stoppedDelivered ? deliveredByRetry / stoppedDelivered : null,
      },
    },
    open: {
      count: open.length,
      older_than_stale: open.filter(
        (question) => now - Date.parse(question.asked_at) > staleAfterMs,
      ).length,
    },
    operator_answers: {
      count: operatorWaits.length,
      median_wait_ms: percentile(
        operatorWaits.toSorted((left, right) => left - right),
        0.5,
      ),
    },
  }
}

export function rulingsStaleAfter(): string {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key = ?`)
    .get(RULINGS_STALE_AFTER_KEY)
  if (!row) return RULINGS_STALE_AFTER_DEFAULT
  try {
    const parsed = JSON.parse(row.value)
    if (typeof parsed === 'string' && durationMs(parsed) != null) return parsed
  } catch {
    /* stored as a bare duration */
  }
  return durationMs(row.value) != null ? row.value : RULINGS_STALE_AFTER_DEFAULT
}

export type OpenRuling = {
  question_id: number
  task_key: string | null
  session_id: string | null
  asked_at: string
  age: number
}

export function listOpenRulings(now = Date.now()): OpenRuling[] {
  const rows = db()
    .query<
      {
        question_id: number
        task_key: string | null
        session_id: string | null
        asked_at: string
      },
      []
    >(
      `SELECT question_id, task_key, session_id, asked_at FROM question
      WHERE answered_at IS NULL
      ORDER BY task_key IS NULL, task_key, question_id`,
    )
    .all()
  return rows.map((row) => {
    const at = Date.parse(row.asked_at)
    return {
      question_id: row.question_id,
      task_key: row.task_key,
      session_id: row.session_id,
      asked_at: row.asked_at,
      age: Number.isFinite(at) ? Math.max(0, now - at) : 0,
    }
  })
}

export function rulingsPayload(now = Date.now()) {
  return { stale_after: rulingsStaleAfter(), questions: listOpenRulings(now) }
}

export function rulingsStatsPayload(days = DEFAULT_STATS_DAYS, now = Date.now()) {
  const questionRows = db()
    .query<RulingMeasureQuestion, []>(
      `SELECT question_id, asked_at, answered_at, asked_via, answerer_kind FROM question`,
    )
    .all()
  const deliveryRows = db()
    .query<RulingMeasureDelivery, []>(`SELECT question_id, mode, outcome FROM question_delivery`)
    .all()
  const staleAfter = rulingsStaleAfter()
  return {
    stale_after: staleAfter,
    stats: measureRulings(questionRows, deliveryRows, {
      days,
      now,
      staleAfterMs: durationMs(staleAfter) ?? ONE_HOUR_MS,
    }),
  }
}
