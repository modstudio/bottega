// concern: workflow child service
/** Gathers the one task/claim fact model used by child services and session surfaces. */

import type { Database } from 'bun:sqlite'
import { boardClaimList } from '../board/board-operations.ts'
import {
  TASK_FLOW_OPEN_STAGE_STATES,
  TASK_FLOW_STAGE_STATES,
} from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import type { ChildClaimFact, ChildTaskFact } from './workflow-child-queue.ts'
import type { HubTaskReference } from './workflow-task-reference.ts'
import { ancestorTaskKeys } from './workflow-task-tree.ts'

export type LiveChildClaim = ChildClaimFact & {
  taken_at: string
}

export async function liveChildClaims(database: Database, project: string, now = Date.now()) {
  const listed = await boardClaimList(project, false, {
    database,
    clock: now,
    taskCursorAuthority: { mode: 'coverage-read', session: null },
  })
  return listed.claims
    .filter((claim) => claim.holder !== 'operator')
    .map<LiveChildClaim>((claim) => ({
      subject_kind: claim.subject.kind,
      subject_value: claim.subject.value,
      holderUserId: claim.holderUserId,
      holderSession: claim.holderSession,
      taken_at: claim.takenAt,
    }))
}

export async function gatherChildTaskFacts(
  database: Database,
  project: string,
  tasks: readonly HubTaskReference[],
  claims: readonly LiveChildClaim[],
): Promise<ChildTaskFact[]> {
  if (tasks.length === 0) return []
  const workflowKeys = [...new Set(tasks.map(({ key }) => key))]
  const cursors = new Map<string, { number: number; state: string }>()
  for (const cursor of await taskFlowReadStore(database).listStages({
    project,
    workflowKeys,
    states: [...TASK_FLOW_STAGE_STATES],
    view: 'summary',
  })) {
    const existing = cursors.get(cursor.workflow_key)
    if (!existing || existing.number < cursor.id)
      cursors.set(cursor.workflow_key, { number: cursor.id, state: cursor.state })
  }
  return tasks.map((task) => {
    const queued = claims.find(
      (claim) => claim.subject_kind === 'queued-task' && claim.subject_value === task.key,
    )
    return {
      key: task.key,
      project: task.project,
      parentKey: task.parent_key ?? null,
      number: Number(/(\d+)$/.exec(task.key)?.[1] ?? Number.MAX_SAFE_INTEGER),
      statusCategory: task.status_category ?? null,
      hasChildren: task.has_children,
      cursorEverComposed: cursors.has(task.key),
      cursorNumber: cursors.get(task.key)?.number ?? null,
      cursorState: cursors.get(task.key)?.state ?? null,
      liveTaskClaimSession:
        claims.find((claim) => claim.subject_kind === 'task' && claim.subject_value === task.key)
          ?.holderSession ?? null,
      liveQueuedClaimSession: queued?.holderSession ?? null,
      queuedAt: queued?.taken_at ?? null,
    }
  })
}

export function childAncestorKeys(key: string, tasks: readonly HubTaskReference[]): string[] {
  return ancestorTaskKeys(
    key,
    tasks.map((task) => ({ key: task.key, parentKey: task.parent_key ?? null })),
  )
}

export async function nearestOpenEpicCursor(
  database: Database,
  project: string,
  ancestorKeys: readonly string[],
) {
  if (ancestorKeys.length === 0) return null
  const stages = await taskFlowReadStore(database).listStages({
    project,
    workflowKeys: [...ancestorKeys],
    states: [...TASK_FLOW_OPEN_STAGE_STATES],
  })
  const byKey = new Map(
    stages
      .filter((stage) => stage.workflow_slug === 'plan-task' && stage.step_slug === 'start')
      .map((stage) => [stage.workflow_key, stage]),
  )
  for (const key of ancestorKeys) {
    const stage = byKey.get(key)
    if (stage) return stage
  }
  return null
}
