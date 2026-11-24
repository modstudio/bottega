// concern: monitor cursor claims
/** Detects open cursor ownership gaps without changing either cursors or claims. */

import type { Database } from 'bun:sqlite'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { claimBoundToOpenCursor } from '../board/board-claim-cursor-binding.ts'
import { claimIsLive } from '../board/board-claim-policy.ts'
import { latestRunStatus } from '../board/board-store.ts'
import { TASK_FLOW_OPEN_STAGE_STATES_SQL } from '../record/record-task-flow-contract.ts'
import type { MonitorCondition } from './monitor-types.ts'

export type OpenKeyedCursorFact = {
  project: string
  id: number
  key: string
  session: string
  isEpic: boolean
}
export type CursorClaimFact = { project: string; key: string; session: string; live: boolean }
type Split = { epic: number[]; nonEpic: number[] }
export type CursorClaimHealth = { unclaimed: Split; ownerNotAlive: Split }

export function cursorClaimHealth(
  cursors: readonly OpenKeyedCursorFact[],
  claims: readonly CursorClaimFact[],
  aliveSessions: ReadonlySet<string>,
): CursorClaimHealth {
  const result: CursorClaimHealth = {
    unclaimed: { epic: [], nonEpic: [] },
    ownerNotAlive: { epic: [], nonEpic: [] },
  }
  for (const cursor of cursors) {
    const split = cursor.isEpic ? 'epic' : 'nonEpic'
    if (
      !claims.some(
        (claim) =>
          claim.live &&
          claim.project === cursor.project &&
          claim.key === cursor.key &&
          claim.session === cursor.session,
      )
    )
      result.unclaimed[split].push(cursor.id)
    if (!aliveSessions.has(cursor.session)) result.ownerNotAlive[split].push(cursor.id)
  }
  return result
}

function splitDetail(split: Split): string {
  return `epic ${split.epic.length} [${split.epic.join(', ') || 'none'}]; non-epic ${split.nonEpic.length} [${split.nonEpic.join(', ') || 'none'}]`
}

export function cursorClaimHealthConditions(
  database: Database,
  clock: number,
): MonitorCondition[] {
  const cursors = database
    .query(
      `SELECT number id,project,workflow_key key,session_id session,
              workflow_slug='plan-task' AND step_slug='start' is_epic
       FROM workflow_cursor
       WHERE workflow_key<>'' AND session_id IS NOT NULL
         AND state IN (${TASK_FLOW_OPEN_STAGE_STATES_SQL})`,
    )
    .all() as Array<{
    id: number
    project: string
    key: string
    session: string
    is_epic: number
  }>
  const claimRows = database
    .query(
      `SELECT project,subject_kind,subject_value,holder_session,lapses_at,closed_at,run_record_id
       FROM board_claim WHERE subject_kind='task' AND closed_at IS NULL`,
    )
    .all() as Array<{
    project: string
    subject_kind: string
    subject_value: string
    holder_session: string | null
    lapses_at: string
    closed_at: string | null
    run_record_id: string | null
  }>
  const claims = claimRows.flatMap((row): CursorClaimFact[] =>
    row.holder_session
      ? [
          {
            project: row.project,
            key: row.subject_value,
            session: row.holder_session,
            live: claimIsLive({
              closed: false,
              lapsesAt: Date.parse(row.lapses_at),
              runStatus: latestRunStatus(row.run_record_id, database),
              now: clock,
              boundToOpenCursor: claimBoundToOpenCursor(row, database),
            }),
          },
        ]
      : [],
  )
  const cutoff = new Date(clock - SESSION_LIVE_MS).toISOString()
  const aliveSessions = new Set(
    (
      database
        .query('SELECT session_id FROM session_seen WHERE last_seen>=?')
        .all(cutoff) as Array<{ session_id: string }>
    ).map(({ session_id }) => session_id),
  )
  const health = cursorClaimHealth(
    cursors.map((cursor) => ({ ...cursor, isEpic: Boolean(cursor.is_epic) })),
    claims,
    aliveSessions,
  )
  const conditions: MonitorCondition[] = []
  if (health.unclaimed.epic.length || health.unclaimed.nonEpic.length)
    conditions.push({
      kind: 'open-cursor-unclaimed',
      subject: 'workflow-cursors',
      since: null,
      ageMs: null,
      detail: splitDetail(health.unclaimed),
      action: 'reported; restore each cursor-bound task claim through its owning workflow cursor',
    })
  if (health.ownerNotAlive.epic.length || health.ownerNotAlive.nonEpic.length)
    conditions.push({
      kind: 'open-cursor-owner-not-alive',
      subject: 'workflow-cursors',
      since: null,
      ageMs: null,
      detail: splitDetail(health.ownerNotAlive),
      action: 'reported only; ownership changes only through recorded takeover',
    })
  return conditions
}
