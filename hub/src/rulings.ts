import { db } from './db.ts'

const RULINGS_STALE_AFTER_KEY = 'rulings.stale_after'
const RULINGS_STALE_AFTER_DEFAULT = '1h'

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function durationMs(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)([smhd])$/)
  return match ? Math.round(Number(match[1]) * UNITS[match[2]!]!) : null
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
