// concern: monitor cursor claims
/** Detects open cursor ownership gaps without changing either cursors or claims. */

import type { Database } from 'bun:sqlite'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { boardClaimList } from '../board/board-operations.ts'
import { TASK_FLOW_OPEN_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
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

export async function cursorClaimHealthConditions(
  database: Database,
  clock: number,
): Promise<MonitorCondition[]> {
  const projectNames = (
    database.query('SELECT name FROM project ORDER BY name').all() as Array<{ name: string }>
  ).map(({ name }) => name)
  const cursors: OpenKeyedCursorFact[] = []
  const claims: CursorClaimFact[] = []
  for (const project of projectNames) {
    const stages = await taskFlowReadStore(database).listStages({
      project,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
    })
    cursors.push(
      ...stages.flatMap((stage): OpenKeyedCursorFact[] =>
        stage.workflow_key && stage.session_id
          ? [
              {
                project,
                id: stage.id,
                key: stage.workflow_key,
                session: stage.session_id,
                isEpic: stage.workflow_slug === 'plan-task' && stage.step_slug === 'start',
              },
            ]
          : [],
      ),
    )
    const listed = await boardClaimList(project, false, {
      database,
      clock,
      taskCursorAuthority: { mode: 'coverage-read', session: null },
    })
    claims.push(
      ...listed.claims.flatMap((claim): CursorClaimFact[] =>
        claim.live && claim.subject.kind === 'task' && claim.holderSession
          ? [
              {
                project,
                key: claim.subject.value,
                session: claim.holderSession,
                live: true,
              },
            ]
          : [],
      ),
    )
  }
  const cutoff = new Date(clock - SESSION_LIVE_MS).toISOString()
  const aliveSessions = new Set(
    (
      database
        .query('SELECT session_id FROM session_seen WHERE last_seen>=?')
        .all(cutoff) as Array<{ session_id: string }>
    ).map(({ session_id }) => session_id),
  )
  const health = cursorClaimHealth(cursors, claims, aliveSessions)
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
