// concern: workflow child service
/** Owns lazy epic-child queueing and inherited cursor composition. */

import type { Database } from 'bun:sqlite'
import { BOARD_CLAIM_DEFAULT_MS } from '../board/board-claim-policy.ts'
import { boardClaimTake, boardQueuedClaimClose } from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { type TaskReadRow, taskReader } from './task-read-port.ts'
import { childEligibility, childQueueState, selectChildToStart } from './workflow-child-queue.ts'
import {
  childAncestorKeys,
  gatherChildTaskFacts,
  liveChildClaims,
} from './workflow-child-facts.ts'
import { followComposeTaskClaim } from './workflow-compose-claim.ts'
import { insertWorkflowCursor } from './workflow-cursor-compose.ts'
import { resolveCompositionLiveAutonomy } from './workflow-cursor-live-autonomy.ts'
import {
  cliWorkflowCursorContext,
  resolveWorkflowCursorContext,
  selectWorkflowCursorByHandle,
} from './workflow-cursor-selection.ts'
import type { ClosedStep } from './workflow-cursor-trail.ts'
import { descendantTaskKeys } from './workflow-task-tree.ts'
import { composeWorkflow } from './workflows.ts'

type StartChildClaimContext = Parameters<typeof boardClaimTake>[1]
type StartChildClaimInput = Parameters<typeof boardClaimTake>[0]
export type WorkflowChildServicePorts = {
  takeTaskClaim?: (
    input: StartChildClaimInput,
    context: StartChildClaimContext,
  ) => ReturnType<typeof boardClaimTake>
}

async function nearestAncestorFlow(key: string, tasks: readonly TaskReadRow[], database: Database) {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const store = taskFlowReadStore(database)
  for (const ancestor of childAncestorKeys(key, tasks)) {
    const recordId = byKey.get(ancestor)?.record_id
    if (!recordId) continue
    const flow = await store.flowForTask(recordId)
    if (flow) return flow.record_id
  }
  return null
}

async function inheritedStart(
  child: string,
  tasks: readonly TaskReadRow[],
  database: Database,
  steps: readonly { slug: string }[],
) {
  const parentFlowRecordId = await nearestAncestorFlow(child, tasks, database)
  if (!parentFlowRecordId) throw new Error(`${child} has no ancestor workflow flow to inherit`)
  const parentFlow = await taskFlowReadStore(database).flowState(parentFlowRecordId)
  const parentStage = parentFlow?.open_stage_cursor_record_id
    ? await taskFlowReadStore(database).stageByRecordId(parentFlow.open_stage_cursor_record_id)
    : null
  if (!parentStage) throw new Error(`${child}'s ancestor flow has no stage to inherit`)
  const startOrdinal = steps.findIndex(({ slug }) => slug === 'start')
  if (startOrdinal < 0) throw new Error('plan-task has no start step')
  const closed = (JSON.parse(parentStage.closed) as ClosedStep[])
    .filter((step) => step.n <= startOrdinal)
    .map((step) => ({
      ...step,
      note: `inherited from cursor ${parentStage.id} step ${step.slug}: ${step.note}`,
    }))
  if (closed.length !== startOrdinal)
    throw new Error(`cursor ${parentStage.id} has not closed every plan-task step before start`)
  return { parentFlowRecordId, startOrdinal, closed }
}

export async function queueWorkflowChild(
  input: {
    project: string
    child: string
    session: string
    callerSession: string
    off: boolean
  },
  database: Database = db(),
) {
  const tasks = taskReader().list({ project: input.project })
  const ancestors = childAncestorKeys(input.child, tasks)
  if (!ancestors.length) throw new Error(`${input.child} is not a child task`)
  const root = ancestors.at(-1)!
  const claims = liveChildClaims(database, input.project)
  const descendants = descendantTaskKeys(
    root,
    tasks.map((task) => ({ key: task.key, parentKey: task.parent_key })),
  )
  const sessionWorksUnderEpic = claims.some(
    (claim) =>
      claim.holder_session === input.callerSession &&
      ((claim.subject_kind === 'task' && claim.subject_value === root) ||
        (claim.subject_kind === 'queued-task' && descendants.has(claim.subject_value))),
  )
  if (!sessionWorksUnderEpic)
    throw new Error(
      `calling session ${input.callerSession} does not hold epic ${root} or a queued child under it`,
    )
  if (input.off) {
    const closed = boardQueuedClaimClose(
      { project: input.project, key: input.child, session: input.session, reason: 'released' },
      Date.now(),
      database,
    )
    return { action: closed.reason ?? 'none', child: input.child, released: closed.closed }
  }
  const facts = await gatherChildTaskFacts(database, input.project, tasks)
  const state = childQueueState(root, input.session, facts)
  const eligibility = childEligibility(state, facts, input.child)
  if (eligibility.action === 'refuse') throw new Error(eligibility.message)
  const claim = await boardClaimTake(
    {
      project: input.project,
      subject: `queued-task:${input.child}`,
      durationMs: BOARD_CLAIM_DEFAULT_MS,
    },
    {
      database,
      taskCursorAuthority: { mode: 'queue-take', session: input.session },
    },
  )
  return { action: claim.action, child: input.child, session: input.session }
}

export async function startWorkflowChild(
  input: { project: string; cursor: number; task?: string; callerSession: string },
  database: Database = db(),
  ports: WorkflowChildServicePorts = {},
) {
  const epic = await selectWorkflowCursorByHandle(
    { project: input.project, workflow: 'plan-task' },
    input.cursor,
    undefined,
    database,
  )
  if (epic.workflow_slug !== 'plan-task' || epic.step_slug !== 'start')
    throw new Error(`cursor ${input.cursor} is not an epic plan-task cursor at start`)
  const tasks = taskReader().list({ project: input.project })
  const facts = await gatherChildTaskFacts(database, input.project, tasks)
  if (!facts.some((task) => task.parentKey === epic.workflow_key))
    throw new Error(`cursor ${input.cursor} is not an epic cursor`)
  const claims = liveChildClaims(database, input.project)
  const descendants = descendantTaskKeys(epic.workflow_key, facts)
  const callerWorksUnderEpic = claims.some(
    (claim) =>
      claim.holder_session === input.callerSession &&
      ((claim.subject_kind === 'task' && claim.subject_value === epic.workflow_key) ||
        (claim.subject_kind === 'queued-task' && descendants.has(claim.subject_value))),
  )
  if (!callerWorksUnderEpic)
    throw new Error(
      `calling session ${input.callerSession} does not hold epic ${epic.workflow_key} or a queued child under it`,
    )
  const state = childQueueState(epic.workflow_key, input.callerSession, facts)
  const selected = selectChildToStart(state, facts, input.task)
  if (selected.action === 'refuse') throw new Error(selected.message)
  const child = tasks.find(({ key }) => key === selected.task.key)!
  const composition = composeWorkflow(
    'plan-task',
    input.project,
    epic.mode_slug,
    { key: child.key },
    database,
  )
  const inheritance = await inheritedStart(child.key, tasks, database, composition.steps)
  const context = await resolveWorkflowCursorContext(
    input.project,
    { key: child.key },
    { ...cliWorkflowCursorContext(), session: input.callerSession },
  )
  const live = await resolveCompositionLiveAutonomy({
    slug: 'plan-task',
    project: input.project,
    mode: epic.mode_slug,
    args: { key: child.key },
    context,
  })
  const row = await insertWorkflowCursor(
    composition,
    context,
    database,
    live.resolution,
    undefined,
    false,
    {
      parentFlowRecordId: inheritance.parentFlowRecordId,
      activeOrdinal: inheritance.startOrdinal,
      activeSlug: 'start',
      closedStepNotes: inheritance.closed,
    },
  )
  await followComposeTaskClaim(row, false, context, database, {
    take: async (claimInput) => {
      const claim = await (ports.takeTaskClaim ?? boardClaimTake)(
        { project: claimInput.project, subject: `task:${claimInput.key}` },
        {
          database,
          taskCursorAuthority: { mode: 'start-child', session: claimInput.session },
        },
      )
      // Take the task claim first; a stranded queued claim is harmless and lapses naturally.
      boardQueuedClaimClose(
        {
          project: claimInput.project,
          key: claimInput.key,
          session: claimInput.session,
          reason: 'started',
        },
        Date.now(),
        database,
      )
      return claim
    },
    release: async () => ({ released: 0 }),
  })
  return {
    child: child.key,
    cursor: { id: row.id, n: row.ordinal + 1, slug: row.step_slug },
    parentFlowRecordId: inheritance.parentFlowRecordId,
  }
}
