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
import { shellWord, workflowCursorReference } from './workflow-cursor-format.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'
import { cursorOwnerAfter } from './workflow-cursor-transition.ts'
import type { WorkflowEvidenceInput } from './workflow-evidence-input.ts'
import { allowedCloseFloor, decideCloseFloors } from './workflow-floor.ts'
import { applyFloorDecision } from './workflow-floor-apply.ts'
import type { FloorEvidencePorts } from './workflow-floor-evidence.ts'
import { handoffSourceRefusal, handoffTargetRefusal } from './workflow-handoff-refusal.ts'
import { productionWorkflowFloorPorts } from './workflow-production-floor-ports.ts'
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
  evidence?: WorkflowEvidenceInput
  floorPorts?: FloorEvidencePorts
  graduatingUntouchedExplore?: true
}

export function handoffTargetArguments(
  row: SelectableCursorRow,
  args: Record<string, string>,
): Record<string, string> {
  return row.workflow_key && !args.key ? { ...args, key: row.workflow_key } : args
}

async function validateHandoffSource(input: HandoffInput, d: Database) {
  const row = input.row
  if (!input.reason.trim()) throw new Error('handoff reason is required; pass --reason "<why>"')
  const cursorLabel = `workflow cursor ${row.id}`
  const sourceRefusal = handoffSourceRefusal({
    cursorLabel,
    state: row.state,
    sourceSession: row.session_id,
    targetSession: input.context.session ?? null,
  })
  if (sourceRefusal) throw new Error(sourceRefusal)
  const openQuestion = (
    await taskFlowReadStore(d, input.context.taskFlowClient).waitingWorkflowQuestions()
  ).find((question) => question.workflow_cursor_record_id === row.record_id)
  if (openQuestion)
    throw new Error(
      `workflow cursor ${row.id} has open workflow question ${openQuestion.question}; answer it, then retry the handoff`,
    )
}

async function validateHandoffSourceFloor(input: HandoffInput, d: Database) {
  const composition = cursorComposition(input.row, d)
  const step = composition.steps[input.row.ordinal]!
  const floors = decideCloseFloors(step, undefined, false)
  allowedCloseFloor(
    await applyFloorDecision(
      input.row,
      floors,
      input.evidence ?? {},
      input.floorPorts ?? productionWorkflowFloorPorts(),
      true,
      d,
      input.context.taskFlowClient,
      false,
      undefined,
      input.context.session,
    ),
    false,
    step,
  )
}

async function validateHandoffSourceForWrite(input: HandoffInput, d: Database) {
  await validateHandoffSource(input, d)
  if (!input.graduatingUntouchedExplore) await validateHandoffSourceFloor(input, d)
}

async function validateHandoffTarget(input: HandoffInput, d: Database) {
  const row = input.row
  const targetArgs = handoffTargetArguments(row, input.args)
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
  const openStageMatches = Boolean(flow && flow.open_stage_cursor_record_id === row.record_id)
  const policyRefusal = handoffTargetRefusal({
    cursorLabel: `workflow cursor ${row.id}`,
    sourceKey: row.workflow_key,
    targetKey,
    openStageMatches,
  })
  if (policyRefusal)
    throw openStageMatches ? new Error(policyRefusal) : new HandoffOpenStageError(policyRefusal)
  if (!flow) throw new Error(`workflow cursor ${row.id} has no task flow; compose it again`)
  return { composition, flow }
}

class HandoffOpenStageError extends Error {}

type HandoffClaim = Awaited<ReturnType<typeof followTaskCursorClaim>>

function shouldReleaseHandoffClaim(claim: HandoffClaim | undefined): boolean {
  return claim !== undefined && claim.claimAction !== 'renewed'
}

function handoffRetry(
  input: HandoffInput,
  composition: ReturnType<typeof composeWorkflow>,
): string {
  const mode = input.mode ? ` --mode ${shellWord(input.mode)}` : ''
  const reference = workflowCursorReference(input.row.id, input.row.project).cli
  const reason = ` --reason ${shellWord(input.reason)}`
  const args = Object.entries(composition.arguments)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return `workflow handoff ${shellWord(input.workflow)}${mode}${reference}${reason}${args}`
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
  await validateHandoffSourceForWrite(input, d)
  if (input.row.workflow_key) return handoffKeyedWorkflow(input, d)

  const validated = await validateHandoffTarget(input, d)
  const key = validated.targetKey
  let claim: HandoffClaim | undefined
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
    claim = await followTaskCursorClaim(
      {
        project: input.row.project,
        taskKey: key,
        session: input.context.session,
        verb: 'handoff',
        database: d,
      },
      input.taskClaimPorts,
    )
    const adopted = await taskFlowReadStore(d, input.context.taskFlowClient).stageByRecordId(
      input.row.record_id,
    )
    if (!adopted)
      throw new Error(`workflow cursor ${input.row.id} disappeared after adopting ${key}`)
    return await handoffKeyedWorkflow({ ...input, row: adopted }, d)
  } catch (error) {
    let releaseWarning: string | undefined
    try {
      if (shouldReleaseHandoffClaim(claim))
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
    const retry =
      error instanceof HandoffOpenStageError
        ? `workflow cursors --project ${shellWord(input.row.project)}`
        : handoffRetry(input, validated.composition)
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
    taskBound: Boolean(workflowKeyOf(composition.arguments)),
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
    graduatingUntouchedExplore: true,
  })
  const row = await taskFlowReadStore(database, context.taskFlowClient).stageByHandle(
    composition.project,
    result.cursor,
  )
  if (!row) throw new Error(`graduated workflow cursor ${result.cursor} cannot be read; retry`)
  return {
    row,
    claimWarning: result.claimWarning,
    graduated: { cursor: source.id, closed: true as const },
  }
}
