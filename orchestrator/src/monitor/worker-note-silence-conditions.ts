// concern: worker-note-silence monitor condition
/** Reports refused worker-note requests when no request has filed in the observation window. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const WORKER_NOTE_SILENCE_WINDOW_MS = 24 * 60 * 60 * 1_000

export type WorkerNoteSilenceFacts = {
  refusalCount: number
  filedCount: number
  latestRefusalClass: string | null
  latestRefusalDetail: string | null
  latestRefusalAt: string | null
}

export function workerNoteSilenceCondition(
  facts: WorkerNoteSilenceFacts,
  clock: number,
): MonitorCondition | null {
  const windowStartedAt = clock - WORKER_NOTE_SILENCE_WINDOW_MS
  const latestRefusalAt = facts.latestRefusalAt
    ? new Date(facts.latestRefusalAt).getTime()
    : Number.NaN
  if (
    facts.refusalCount < 1 ||
    facts.filedCount > 0 ||
    !Number.isFinite(latestRefusalAt) ||
    latestRefusalAt < windowStartedAt
  ) {
    return null
  }
  const refusalClass = facts.latestRefusalClass ?? 'unknown'
  const detail = withholdSecretShapedDetail(
    facts.latestRefusalDetail?.trim() || 'no detail recorded',
  )
  return {
    kind: 'worker-note-silence',
    subject: 'worker-note-request',
    since: facts.latestRefusalAt,
    ageMs: Math.max(0, clock - latestRefusalAt),
    detail: `${facts.refusalCount} worker note request(s) were refused with no filing in the observation window; latest refusal: ${refusalClass}: ${detail}`,
    action: `file a note with ${PLATFORM_SLUG} note new naming the detail`,
  }
}

export function workerNoteSilenceConditions(database: Database, clock: number): MonitorCondition[] {
  const windowStartedAt = new Date(clock - WORKER_NOTE_SILENCE_WINDOW_MS).toISOString()
  const facts = database
    .query<
      {
        refusal_count: number
        filed_count: number
        latest_refusal_class: string | null
        latest_refusal_detail: string | null
        latest_refusal_at: string | null
      },
      [string]
    >(
      `WITH recent AS (
         SELECT status,refusal_class,detail,requested_at
           FROM worker_note_request WHERE requested_at>=?
       )
       SELECT COALESCE(SUM(CASE WHEN status='refused' THEN 1 ELSE 0 END),0) refusal_count,
              COALESCE(SUM(CASE WHEN status='filed' THEN 1 ELSE 0 END),0) filed_count,
              (SELECT refusal_class FROM recent WHERE status='refused'
                ORDER BY requested_at DESC LIMIT 1) latest_refusal_class,
              (SELECT detail FROM recent WHERE status='refused'
                ORDER BY requested_at DESC LIMIT 1) latest_refusal_detail,
              (SELECT requested_at FROM recent WHERE status='refused'
                ORDER BY requested_at DESC LIMIT 1) latest_refusal_at
         FROM recent`,
    )
    .get(windowStartedAt)!
  const condition = workerNoteSilenceCondition(
    {
      refusalCount: facts.refusal_count,
      filedCount: facts.filed_count,
      latestRefusalClass: facts.latest_refusal_class,
      latestRefusalDetail: facts.latest_refusal_detail,
      latestRefusalAt: facts.latest_refusal_at,
    },
    clock,
  )
  return condition ? [condition] : []
}
