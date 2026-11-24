// concern: monitor cursor claims
/** Detects open cursor ownership gaps without changing either cursors or claims. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { boardClaimList } from '../board/board-operations.ts'
import { projects } from '../project/projects.ts'
import {
  TASK_FLOW_OPEN_STAGE_STATES,
  TASK_FLOW_STAGE_STATES,
} from '../record/record-task-flow-contract.ts'
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
type OpenStageFact = {
  id: number
  workflow_key: string
  session_id: string | null
  task_flow_record_id: string | null
}
type CursorClaimProjectFacts = {
  cursors: OpenKeyedCursorFact[]
  claims: CursorClaimFact[]
}

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
  return `epic ${split.epic.length} [${split.epic.join(', ') || 'none'}]; non-epic ${split.nonEpic.length} [${split.nonEpic.join(', ') || 'none'}]; epics with no recorded child flow count as non-epic`
}

export function openKeyedCursorFacts(
  project: string,
  stages: readonly OpenStageFact[],
  childParentFlowRecordIds: ReadonlySet<string>,
): OpenKeyedCursorFact[] {
  return stages.flatMap((stage): OpenKeyedCursorFact[] =>
    stage.workflow_key && stage.session_id
      ? [
          {
            project,
            id: stage.id,
            key: stage.workflow_key,
            session: stage.session_id,
            isEpic:
              stage.task_flow_record_id !== null &&
              childParentFlowRecordIds.has(stage.task_flow_record_id),
          },
        ]
      : [],
  )
}

export async function cursorClaimHealthConditionsForProjects(
  projectNames: readonly string[],
  aliveSessions: ReadonlySet<string>,
  readProject: (project: string) => Promise<CursorClaimProjectFacts>,
): Promise<MonitorCondition[]> {
  const cursors: OpenKeyedCursorFact[] = []
  const claims: CursorClaimFact[] = []
  const conditions: MonitorCondition[] = []
  for (const project of projectNames) {
    try {
      const facts = await readProject(project)
      cursors.push(...facts.cursors)
      claims.push(...facts.claims)
    } catch (cause) {
      conditions.push({
        kind: 'observation-error',
        subject: `workflow-cursors:${project}`,
        since: null,
        ageMs: null,
        detail: `${project} cursor claim observation unavailable: ${String((cause as Error).message ?? cause)}`,
        action: `reported; restore readable task-flow cursor and claim data for ${project}, then run ${PLATFORM_SLUG} machine monitor`,
        affectedProject: project,
      })
    }
  }
  const health = cursorClaimHealth(cursors, claims, aliveSessions)
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

export async function cursorClaimHealthConditions(
  database: Database,
  clock: number,
): Promise<MonitorCondition[]> {
  const cutoff = new Date(clock - SESSION_LIVE_MS).toISOString()
  const aliveSessions = new Set(
    (
      database
        .query('SELECT session_id FROM session_seen WHERE last_seen>=?')
        .all(cutoff) as Array<{ session_id: string }>
    ).map(({ session_id }) => session_id),
  )
  return cursorClaimHealthConditionsForProjects(
    projects({}, database).map(({ name }) => name),
    aliveSessions,
    async (project) => {
      const store = taskFlowReadStore(database)
      const stages = await store.listStages({
        project,
        states: [...TASK_FLOW_STAGE_STATES],
        view: 'summary',
      })
      const flowRecordIds = new Set(
        stages.flatMap(({ task_flow_record_id }) =>
          task_flow_record_id ? [task_flow_record_id] : [],
        ),
      )
      const childParentFlowRecordIds = new Set(
        (
          await Promise.all([...flowRecordIds].map((recordId) => store.flowState(recordId)))
        ).flatMap((flow) => (flow?.parent_flow_record_id ? [flow.parent_flow_record_id] : [])),
      )
      const openStates = new Set<string>(TASK_FLOW_OPEN_STAGE_STATES)
      const listed = await boardClaimList(project, false, {
        database,
        clock,
        taskCursorAuthority: { mode: 'coverage-read', session: null },
      })
      return {
        cursors: openKeyedCursorFacts(
          project,
          stages.filter(({ state }) => openStates.has(state)),
          childParentFlowRecordIds,
        ),
        claims: listed.claims.flatMap((claim): CursorClaimFact[] =>
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
      }
    },
  )
}
