// concern: workflow child service
/** Gathers the one task/claim fact model used by child services and session surfaces. */

import type { Database } from 'bun:sqlite'
import { boardLiveClaimsForProject } from '../board/board-operations.ts'
import { TASK_FLOW_STAGE_STATES } from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import type { TaskReadRow } from './task-read-port.ts'
import type { ChildTaskFact } from './workflow-child-queue.ts'
import { ancestorTaskKeys } from './workflow-task-tree.ts'

export type LiveChildClaim = {
  subject_kind: string
  subject_value: string
  holder_session: string
  taken_at: string
}

export function liveChildClaims(database: Database, project: string, now = Date.now()) {
  return boardLiveClaimsForProject(project, now, database)
    .filter((claim) => claim.holder !== 'operator')
    .map<LiveChildClaim>((claim) => ({
      subject_kind: claim.subject.kind,
      subject_value: claim.subject.value,
      holder_session: claim.holder,
      taken_at: claim.takenAt,
    }))
}

export async function gatherChildTaskFacts(
  database: Database,
  project: string,
  tasks: readonly TaskReadRow[],
): Promise<ChildTaskFact[]> {
  const cursors = new Map<string, { number: number; state: string }>()
  for (const cursor of await taskFlowReadStore(database).listStages({
    project,
    states: [...TASK_FLOW_STAGE_STATES],
  })) {
    const existing = cursors.get(cursor.workflow_key)
    if (!existing || existing.number < cursor.id)
      cursors.set(cursor.workflow_key, { number: cursor.id, state: cursor.state })
  }
  const claims = liveChildClaims(database, project)
  return tasks.map((task) => {
    const queued = claims.find(
      (claim) => claim.subject_kind === 'queued-task' && claim.subject_value === task.key,
    )
    return {
      key: task.key,
      parentKey: task.parent_key,
      number: Number(/(\d+)$/.exec(task.key)?.[1] ?? Number.MAX_SAFE_INTEGER),
      statusCategory: task.status_category,
      cursorEverComposed: cursors.has(task.key),
      cursorNumber: cursors.get(task.key)?.number ?? null,
      cursorState: cursors.get(task.key)?.state ?? null,
      liveTaskClaimSession:
        claims.find((claim) => claim.subject_kind === 'task' && claim.subject_value === task.key)
          ?.holder_session ?? null,
      liveQueuedClaimSession: queued?.holder_session ?? null,
      queuedAt: queued?.taken_at ?? null,
    }
  })
}

export function childAncestorKeys(key: string, tasks: readonly TaskReadRow[]): string[] {
  return ancestorTaskKeys(
    key,
    tasks.map((task) => ({ key: task.key, parentKey: task.parent_key })),
  )
}
