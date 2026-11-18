// concern: workflow handoff
/** Atomically closes one keyed stage and opens its explicitly named successor. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { type TaskFlowIntentInput, workflowStageInsert } from './task-flow-store-types.ts'
import type { CommitCountPort } from './workflow-compose-branch.ts'
import { readCommitsPastLanding, workflowComposeBranchRefusal } from './workflow-compose-branch.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { storedCursorAutonomyForComposition } from './workflow-cursor-autonomy.ts'
import { graduatingExploreCursor } from './workflow-cursor-compose.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { cursorComposition, type CursorSummary } from './workflow-cursor-serve.ts'
import { cursorOwnerAfter } from './workflow-cursor-transition.ts'
import { taskFlowHandoffRefusal } from './workflow-handoff-refusal.ts'
import {
  followTaskCursorClaim,
  type TaskCursorClaimPorts,
  taskClaimFollowWarning,
  taskClaimReleaseWarning,
} from './workflow-task-claim.ts'
import { composeWorkflow } from './workflows.ts'

type HandoffInput = {
  row: SelectableCursorRow
  workflow: string
  mode?: string
  args: Record<string, string>
  reason: string
  context: WorkflowCursorContext
  live: LiveCursorAutonomy
  database?: Database
  commitCount?: CommitCountPort
  taskClaimPorts?: TaskCursorClaimPorts
}

async function validateHandoffTarget(input: HandoffInput, d: Database) {
  const row = input.row
  if (!input.reason.trim()) throw new Error('handoff reason is required; pass --reason "<why>"')
  const cursorLabel = `workflow cursor ${row.id}`
  const sourceRefusal = taskFlowHandoffRefusal({
    cursorLabel,
    state: row.state,
    sourceKey: row.workflow_key || null,
    targetKey: row.workflow_key || null,
    sourceSession: row.session_id,
    targetSession: input.context.session ?? null,
    openStageMatches: true,
  })
  if (sourceRefusal) throw new Error(sourceRefusal)
  const openQuestion = (
    await taskFlowReadStore(d, input.context.taskFlowClient).waitingWorkflowQuestions()
  ).find((question) => question.workflow_cursor_record_id === row.record_id)
  if (openQuestion)
    throw new Error(
      `workflow cursor ${row.id} has open workflow question ${openQuestion.question}; answer it, then retry the handoff`,
    )
  const targetArgs =
    row.workflow_key && !input.args.key ? { ...input.args, key: row.workflow_key } : input.args
  const composition = composeWorkflow(
    input.workflow,
    row.project,
    input.mode,
    targetArgs,
    d,
    {},
    input.live.resolution,
  )
  if (!composition.mode)
    throw new Error(`workflow "${input.workflow}" needs a mode; pass --mode <slug>`)
  if (composition.needs.arguments)
    throw new Error(
      `workflow "${input.workflow}" needs arguments: ${composition.needs.arguments.map((argument) => argument.name).join(', ')}; pass each with --arg k=v`,
    )
  const targetKey = workflowKeyOf(composition.arguments)
  if (!targetKey) throw new Error('keyless handoff requires a task key; pass --arg key=<KEY>')
  const refusal = workflowComposeBranchRefusal({
    workflow: composition.workflow.slug,
    project: row.project,
    args: composition.arguments,
    d,
    commitCount: input.commitCount ?? readCommitsPastLanding,
  })
  if (refusal) throw new Error(refusal)
  return { composition, targetKey }
}

async function validateHandoff(input: HandoffInput, d: Database) {
  const { composition, targetKey } = await validateHandoffTarget(input, d)
  const row = input.row
  const flow = row.task_flow_record_id
    ? await taskFlowReadStore(d, input.context.taskFlowClient).flowState(row.task_flow_record_id)
    : null
  const policyRefusal = taskFlowHandoffRefusal({
    cursorLabel: `workflow cursor ${row.id}`,
    state: row.state,
    sourceKey: row.workflow_key,
    targetKey,
    sourceSession: row.session_id,
    targetSession: input.context.session ?? null,
    openStageMatches: Boolean(flow && flow.open_stage_cursor_record_id === row.record_id),
  })
  if (policyRefusal) throw new Error(policyRefusal)
  if (!flow) throw new Error(`workflow cursor ${row.id} has no task flow; compose it again`)
  return { composition, flow }
}

function handoffPayload(
  input: HandoffInput,
  d: Database,
  validated: Awaited<ReturnType<typeof validateHandoff>>,
): TaskFlowIntentInput<'handoff'> {
  const { row } = input
  const { composition, flow } = validated
  const at = nowIso()
  const nextId = newRecordId()
  const machine = machineId()
  const oldComposition = cursorComposition(row, d)
  const projectId = d
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(row.project)!.record_id
  return {
    requestId: taskFlowRequestId('handoff', [row.record_id, String(row.revision)]),
    flow: {
      id: flow.record_id,
      expectedRevision: flow.revision,
      values: { openStageRecordId: nextId, updatedMachineId: machine, updatedAt: at },
    },
    oldStage: { id: row.record_id, expectedRevision: row.revision },
    newStage: {
      ...workflowStageInsert({
        id: nextId,
        flowRecordId: flow.record_id,
        projectId,
        workflow: composition.workflow.slug,
        mode: composition.mode!.slug,
        workflowKey: row.workflow_key,
        instanceId: '',
        sessionId: cursorOwnerAfter('handoff', null, input.context.session),
        workflowVersionId: composition.workflow.record_id,
        catalogueVersionId: composition.catalogue.record_id,
        arguments: composition.arguments,
        activeSlug: composition.steps[0]!.slug,
        autonomy: storedCursorAutonomyForComposition(input.live.resolution, composition),
        totalSteps: composition.steps.length,
        openedMachineId: machine,
        createdAt: at,
      }),
      handedOffFromRecordId: row.record_id,
    },
    trail: {
      closed: JSON.parse(row.closed) as unknown[],
      current: { n: row.ordinal + 1, slug: row.step_slug },
      remaining: oldComposition.steps
        .slice(row.ordinal + 1)
        .map((step, offset) => ({ n: row.ordinal + offset + 2, slug: step.slug })),
      targetWorkflow: composition.workflow.slug,
      reason: input.reason.trim(),
      at,
    },
  }
}

async function handoffKeyedWorkflow(input: HandoffInput, d: Database) {
  const row = input.row
  const validated = await validateHandoff(input, d)
  const payload = handoffPayload(input, d, validated)
  const hosted = await writeHostedTaskFlow(
    'handoff',
    payload,
    taskFlowWriteTarget(row.project, d),
    input.context.taskFlowClient,
  )
  const applied = writeTransaction(() => taskFlowLocalStore(d).write('handoff', payload, hosted), d)
  let claimWarning: string | undefined
  try {
    await followTaskCursorClaim(
      {
        project: row.project,
        taskKey: row.workflow_key,
        session: input.context.session,
        verb: 'handoff',
        database: d,
      },
      input.taskClaimPorts,
    )
  } catch (error) {
    claimWarning = taskClaimFollowWarning(row.workflow_key, error)
  }
  return {
    oldCursor: row.id,
    cursor: applied.stage.number,
    workflow: validated.composition.workflow.slug,
    ...(claimWarning ? { claimWarning } : {}),
  }
}

export async function handoffWorkflow(input: HandoffInput) {
  const d = input.database ?? db()
  if (input.row.workflow_key) return handoffKeyedWorkflow(input, d)

  const validated = await validateHandoffTarget(input, d)
  const key = validated.targetKey
  const claim = await followTaskCursorClaim(
    {
      project: input.row.project,
      taskKey: key,
      session: input.context.session,
      verb: 'handoff',
      database: d,
    },
    input.taskClaimPorts,
  )
  let adoptedCursor = false
  try {
    await adoptWorkflowTask(
      input.row,
      key,
      input.context.taskRecordId,
      d,
      input.context.taskFlowClient,
      input.context.taskStatusCategory,
    )
    adoptedCursor = true
    const adopted = await taskFlowReadStore(d, input.context.taskFlowClient).stageByRecordId(
      input.row.record_id,
    )
    if (!adopted)
      throw new Error(`workflow cursor ${input.row.id} disappeared after adopting ${key}`)
    return await handoffKeyedWorkflow({ ...input, row: adopted }, d)
  } catch (error) {
    let releaseWarning: string | undefined
    try {
      if (claim.claimAction !== 'renewed')
        await followTaskCursorClaim(
          {
            project: input.row.project,
            taskKey: key,
            session: input.context.session,
            verb: 'abandon',
            database: d,
          },
          input.taskClaimPorts,
        )
    } catch (releaseError) {
      releaseWarning = taskClaimReleaseWarning(input.row.project, key, releaseError)
    }
    const detail = error instanceof Error ? error.message : String(error)
    const retry = `workflow handoff ${input.workflow}${workflowCursorReference(input.row.id, input.row.project).cli} --arg key=${key}`
    throw new Error(
      `${detail}; cursor ${input.row.id} ${adoptedCursor ? `is now keyed to ${key}` : 'remains keyless'}; retry with ${retry}${releaseWarning ? `; ${releaseWarning}` : ''}`,
    )
  }
}

export async function handoffGraduatingExplore(
  composition: ReturnType<typeof composeWorkflow>,
  context: WorkflowCursorContext,
  database: Database,
  live: LiveCursorAutonomy,
  commitCount: CommitCountPort,
  taskClaimPorts?: TaskCursorClaimPorts,
) {
  const source = await graduatingExploreCursor({
    project: composition.project,
    session: context.session,
    taskBound: Boolean(composition.arguments.key),
    database,
    taskFlowClient: context.taskFlowClient,
  })
  if (!source) return undefined
  const result = await handoffWorkflow({
    row: source,
    workflow: composition.workflow.slug,
    mode: composition.mode!.slug,
    args: composition.arguments,
    reason: `graduated to ${composition.workflow.slug}`,
    context,
    live,
    database,
    commitCount,
    taskClaimPorts,
  })
  const row = await taskFlowReadStore(database, context.taskFlowClient).stageByHandle(
    composition.project,
    result.cursor,
  )
  if (!row) throw new Error(`graduated workflow cursor ${result.cursor} cannot be read; retry`)
  return {
    ...cursorComposition(row, database, live),
    cursor: {
      id: row.id,
      n: row.ordinal + 1,
      slug: row.step_slug,
      state: row.state,
      opened: true as const,
      previousSession: null,
    } satisfies CursorSummary,
    ...(result.claimWarning ? { claimWarning: result.claimWarning } : {}),
    graduated: { cursor: source.id, closed: true as const },
  }
}

export type GraduatedExplore = { cursor: number; closed: true }
