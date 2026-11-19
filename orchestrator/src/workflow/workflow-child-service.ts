// concern: workflow child service
/** Owns lazy epic-child queueing and inherited cursor composition. */

import type { Database } from 'bun:sqlite'
import { BOARD_CLAIM_DEFAULT_MS } from '../board/board-claim-policy.ts'
import { boardClaimTake } from '../board/board-operations.ts'
import { db, writeTransaction } from '../database/db.ts'
import {
  TASK_FLOW_OPEN_STAGE_STATES,
  TASK_FLOW_STAGE_STATES,
} from '../record/record-task-flow-contract.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { type TaskReadRow, taskReader } from './task-read-port.ts'
import { type ChildTaskFact, childQueueState, selectChildToStart } from './workflow-child-queue.ts'
import { followComposeTaskClaim } from './workflow-compose-claim.ts'
import { insertWorkflowCursor } from './workflow-cursor-compose.ts'
import { resolveCompositionLiveAutonomy } from './workflow-cursor-live-autonomy.ts'
import {
  cliWorkflowCursorContext,
  resolveWorkflowCursorContext,
  selectWorkflowCursorByHandle,
} from './workflow-cursor-selection.ts'
import type { ClosedStep } from './workflow-cursor-trail.ts'
import { composeWorkflow } from './workflows.ts'

const taskNumber = (key: string): number =>
  Number(/(\d+)$/.exec(key)?.[1] ?? Number.MAX_SAFE_INTEGER)

function liveClaimRows(database: Database, project: string, now = Date.now()) {
  return database
    .query<
      { subject_kind: string; subject_value: string; holder_session: string; taken_at: string },
      [string, string]
    >(
      `SELECT subject_kind,subject_value,holder_session,taken_at FROM board_claim
       WHERE project=? AND closed_at IS NULL AND lapses_at>? ORDER BY taken_at,record_id`,
    )
    .all(project, new Date(now).toISOString())
}

async function childFacts(
  database: Database,
  project: string,
  tasks: readonly TaskReadRow[],
): Promise<ChildTaskFact[]> {
  const cursors = new Set(
    (
      await taskFlowReadStore(database).listStages({
        project,
        states: [...TASK_FLOW_STAGE_STATES],
      })
    ).map(({ workflow_key }) => workflow_key),
  )
  const claims = liveClaimRows(database, project)
  return tasks.map((task) => ({
    key: task.key,
    parentKey: task.parent_key,
    number: taskNumber(task.key),
    statusCategory: task.status_category,
    cursorEverComposed: cursors.has(task.key),
    liveTaskClaimSession:
      claims.find((claim) => claim.subject_kind === 'task' && claim.subject_value === task.key)
        ?.holder_session ?? null,
    liveQueuedClaimSession:
      claims.find(
        (claim) => claim.subject_kind === 'queued-task' && claim.subject_value === task.key,
      )?.holder_session ?? null,
    queuedAt:
      claims.find(
        (claim) => claim.subject_kind === 'queued-task' && claim.subject_value === task.key,
      )?.taken_at ?? null,
  }))
}

function ancestorKeys(key: string, tasks: readonly TaskReadRow[]): string[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const keys: string[] = []
  let parent = byKey.get(key)?.parent_key ?? null
  while (parent) {
    keys.push(parent)
    parent = byKey.get(parent)?.parent_key ?? null
  }
  return keys
}

async function nearestAncestorFlow(key: string, tasks: readonly TaskReadRow[], database: Database) {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const store = taskFlowReadStore(database)
  for (const ancestor of ancestorKeys(key, tasks)) {
    const recordId = byKey.get(ancestor)?.record_id
    if (!recordId) continue
    const flow = await store.flowForTask(recordId)
    if (flow) return flow.record_id
  }
  return null
}

export async function queueWorkflowChild(
  input: { project: string; child: string; session: string; off: boolean },
  database: Database = db(),
) {
  const tasks = taskReader().list({ project: input.project })
  const ancestors = ancestorKeys(input.child, tasks)
  if (!ancestors.length) throw new Error(`${input.child} is not a child task`)
  const claims = liveClaimRows(database, input.project)
  const sessionWorksUnderEpic = ancestors.some((key) =>
    claims.some(
      (claim) =>
        claim.holder_session === input.session &&
        ((claim.subject_kind === 'task' && claim.subject_value === key) ||
          (claim.subject_kind === 'queued-task' && claim.subject_value === input.child)),
    ),
  )
  if (!sessionWorksUnderEpic)
    throw new Error(
      `session ${input.session} does not hold an epic or queued child above ${input.child}`,
    )
  if (input.off) {
    const changed = database
      .query(
        `UPDATE board_claim SET closed_at=?,close_reason='released'
         WHERE project=? AND subject_kind='queued-task' AND subject_value=?
           AND holder_session=? AND closed_at IS NULL`,
      )
      .run(new Date().toISOString(), input.project, input.child, input.session).changes
    return { action: 'released' as const, child: input.child, released: changed }
  }
  const facts = await childFacts(database, input.project, tasks)
  const root = ancestors.at(-1)!
  const state = childQueueState(root, input.session, facts)
  const child = facts.find((task) => task.key === input.child)
  if (!child) throw new Error(`${input.child} was not found`)
  if (child.liveTaskClaimSession)
    throw new Error(`${input.child} is claimed by session ${child.liveTaskClaimSession}`)
  if (child.liveQueuedClaimSession && child.liveQueuedClaimSession !== input.session)
    throw new Error(`${input.child} is queued for session ${child.liveQueuedClaimSession}`)
  if (!state.open.some(({ key }) => key === input.child) && child.liveQueuedClaimSession === null)
    throw new Error(`${input.child} is not queueable under epic ${root}`)
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
  input: { project: string; cursor: number; task?: string },
  database: Database = db(),
) {
  const epic = await selectWorkflowCursorByHandle(
    { project: input.project, workflow: 'plan-task' },
    input.cursor,
    undefined,
    database,
  )
  if (epic.workflow_slug !== 'plan-task' || epic.step_slug !== 'start')
    throw new Error(`cursor ${input.cursor} is not an epic plan-task cursor at start`)
  if (!epic.session_id) throw new Error(`cursor ${input.cursor} has no owning session`)
  const tasks = taskReader().list({ project: input.project })
  const facts = await childFacts(database, input.project, tasks)
  const state = childQueueState(epic.workflow_key, epic.session_id, facts)
  if (!facts.some((task) => task.parentKey === epic.workflow_key))
    throw new Error(`cursor ${input.cursor} is not an epic cursor`)
  const selected = selectChildToStart(state, input.task)
  if (selected.action === 'refuse') {
    const held = facts.find(({ key }) => key === input.task)
    if (held?.liveQueuedClaimSession)
      throw new Error(`${held.key} is queued for session ${held.liveQueuedClaimSession}`)
    if (held?.liveTaskClaimSession)
      throw new Error(`${held.key} is claimed by session ${held.liveTaskClaimSession}`)
    throw new Error(selected.message)
  }
  const child = tasks.find(({ key }) => key === selected.task.key)!
  const parentFlowRecordId = await nearestAncestorFlow(child.key, tasks, database)
  if (!parentFlowRecordId) throw new Error(`${child.key} has no ancestor workflow flow to inherit`)
  const parentFlow = await taskFlowReadStore(database).flowState(parentFlowRecordId)
  const parentStage = parentFlow?.open_stage_cursor_record_id
    ? await taskFlowReadStore(database).stageByRecordId(parentFlow.open_stage_cursor_record_id)
    : null
  if (!parentStage) throw new Error(`${child.key}'s ancestor flow has no stage to inherit`)
  const composition = composeWorkflow(
    'plan-task',
    input.project,
    epic.mode_slug,
    { key: child.key },
    database,
  )
  const startOrdinal = composition.steps.findIndex(({ slug }) => slug === 'start')
  if (startOrdinal < 0) throw new Error('plan-task has no start step')
  const inherited = (JSON.parse(parentStage.closed) as ClosedStep[])
    .filter((step) => step.n <= startOrdinal)
    .map((step) => ({
      ...step,
      note: `inherited from cursor ${parentStage.id} step ${step.slug}: ${step.note}`,
    }))
  if (inherited.length !== startOrdinal)
    throw new Error(`cursor ${parentStage.id} has not closed every plan-task step before start`)
  const context = await resolveWorkflowCursorContext(
    input.project,
    { key: child.key },
    { ...cliWorkflowCursorContext(), session: epic.session_id },
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
      parentFlowRecordId,
      activeOrdinal: startOrdinal,
      activeSlug: 'start',
      closedStepNotes: inherited,
    },
  )
  await followComposeTaskClaim(row, false, context, database, {
    take: async (claimInput) => {
      const claim = await boardClaimTake(
        { project: claimInput.project, subject: `task:${claimInput.key}` },
        {
          database,
          taskCursorAuthority: { mode: 'take', session: claimInput.session },
        },
      )
      writeTransaction(() => {
        database
          .query(
            `UPDATE board_claim SET closed_at=?,close_reason='started'
               WHERE project=? AND subject_kind='queued-task' AND subject_value=?
                 AND holder_session=? AND closed_at IS NULL`,
          )
          .run(new Date().toISOString(), claimInput.project, claimInput.key, claimInput.session)
      }, database)
      return claim
    },
    release: async () => ({ released: 0 }),
  })
  return {
    child: child.key,
    cursor: { id: row.id, n: row.ordinal + 1, slug: row.step_slug },
    parentFlowRecordId,
  }
}

export async function sessionEpicWork(session: string, database: Database = db()) {
  const sessionStages = await taskFlowReadStore(database).listOpenStages({ sessionId: session })
  const claimProjects = database
    .query<{ project: string }, [string]>(
      'SELECT DISTINCT project FROM board_claim WHERE holder_session=? AND closed_at IS NULL',
    )
    .all(session)
  const projects = [
    ...new Set([
      ...claimProjects.map(({ project }) => project),
      ...sessionStages.map(({ project }) => project),
    ]),
  ]
  const surfaces: Array<{ epic: string; queue: string[]; open: string[]; cursor: number }> = []
  for (const project of projects) {
    const tasks = taskReader().list({ project })
    const facts = await childFacts(database, project, tasks)
    const queued = new Set(
      facts
        .filter(({ liveQueuedClaimSession }) => liveQueuedClaimSession === session)
        .map(({ key }) => ancestorKeys(key, tasks).at(-1))
        .filter((key): key is string => Boolean(key)),
    )
    const projectStages = await taskFlowReadStore(database).listStages({
      project,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
    })
    const heldTaskKeys = new Set(
      liveClaimRows(database, project)
        .filter((claim) => claim.holder_session === session && claim.subject_kind === 'task')
        .map(({ subject_value }) => subject_value),
    )
    const epicCursors = projectStages
      .filter(
        (stage) =>
          stage.workflow_slug === 'plan-task' &&
          stage.step_slug === 'start' &&
          (stage.session_id === session || heldTaskKeys.has(stage.workflow_key)),
      )
      .map((stage) => ({ number: stage.id, workflow_key: stage.workflow_key }))
    for (const epic of epicCursors) queued.add(epic.workflow_key)
    for (const epicKey of queued) {
      const cursor =
        epicCursors.find(({ workflow_key }) => workflow_key === epicKey) ??
        projectStages
          .filter(
            (stage) =>
              stage.workflow_slug === 'plan-task' &&
              stage.step_slug === 'start' &&
              stage.workflow_key === epicKey,
          )
          .map((stage) => ({ number: stage.id, workflow_key: stage.workflow_key }))[0]
      if (!cursor) continue
      const state = childQueueState(epicKey, session, facts)
      surfaces.push({
        epic: epicKey,
        queue: state.queue.map(({ key }) => key),
        open: state.open.map(({ key }) => key),
        cursor: cursor.number,
      })
    }
  }
  return surfaces
}
