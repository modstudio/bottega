// concern: workflow cursor compose
/** Owns hosted-first cursor insertion, keyless slot identity, and compose replay recovery. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { machineId } from '../record/machine-identity.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  resolveTaskFlowDestination,
  type TaskFlowWriteTarget,
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import {
  type TaskFlowComposeResult,
  type TaskFlowIntentInput,
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import type { AutonomyResolution } from './autonomy.ts'
import {
  cacheAdoptedTaskFlow,
  insertWorkflowCursorRow,
  refuseTaskFlowStageConflict,
} from './task-flow.ts'
import { taskFlowState } from './task-flow-decision.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'
import type { WorkflowCursorInsert } from './task-flow-store-types.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
  workflowComposeBranchRefusal,
} from './workflow-compose-branch.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { storedCursorAutonomyJson } from './workflow-cursor-autonomy.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { refuseUnlinkedCursorLabelCollision } from './workflow-cursor-task-reference.ts'
import type { composeWorkflow } from './workflows.ts'

type Composition = ReturnType<typeof composeWorkflow>
type ExistingFlow = { record_id: string; revision: number } | null
type ComposeFacts = {
  rowInput: WorkflowCursorInsert
  existingFlow: ExistingFlow
  flowRecordId: string
  projectRecordId: string
  key: string
  instance: string
  machine: string
  at: string
  autonomyJson: string | null
}

function decideKeylessComposeInstance(input: {
  key: string
  owner: string
  projectRecordId: string
  workflow: string
  mode: string
  ordinal: number
}): string {
  if (input.key) return ''
  return taskFlowRequestId('compose', [
    'keyless-instance',
    input.owner,
    input.projectRecordId,
    input.workflow,
    input.mode,
    String(input.ordinal),
  ])
}

async function keylessComposeOrdinal(
  composition: Composition,
  context: WorkflowCursorContext,
  projectRecordId: string,
  machine: string,
  database: Database,
): Promise<number> {
  const input = {
    projectRecordId,
    workflow: composition.workflow.slug,
    mode: composition.mode!.slug,
    sessionId: context.session ?? null,
    machineId: machine,
  }
  const [hostedSlot, localSlot] = await Promise.all([
    taskFlowReadStore(database, context.taskFlowClient).nextKeylessInstanceSlot(input),
    sqliteTaskFlowReadStore(database).nextKeylessInstanceSlot(input),
  ])
  return Math.max(localSlot, hostedSlot - 1)
}

async function readComposeFacts(
  composition: Composition,
  context: WorkflowCursorContext,
  autonomy: AutonomyResolution | undefined,
  database: Database,
  keylessOrdinalOffset = 0,
): Promise<ComposeFacts> {
  const key = workflowKeyOf(composition.arguments)
  const projectRecordId = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(composition.project)!.record_id
  const existingFlow = context.taskRecordId
    ? await taskFlowReadStore(database).flowForTask(context.taskRecordId)
    : null
  if (context.taskRecordId && key)
    await refuseTaskFlowStageConflict(
      {
        taskRecordId: context.taskRecordId,
        taskKey: key,
        workflow: composition.workflow.slug,
        mode: composition.mode!.slug,
      },
      database,
    )
  if (key)
    await refuseUnlinkedCursorLabelCollision(database, {
      project: composition.project,
      workflow: composition.workflow.slug,
      mode: composition.mode!.slug,
      key,
      taskRecordId: context.taskRecordId,
    })
  const at = nowIso()
  const machine = machineId()
  const owner = context.session ?? machine
  const ordinal = key
    ? 0
    : (await keylessComposeOrdinal(composition, context, projectRecordId, machine, database)) +
      keylessOrdinalOffset
  const instance = decideKeylessComposeInstance({
    key,
    owner,
    projectRecordId,
    workflow: composition.workflow.slug,
    mode: composition.mode!.slug,
    ordinal,
  })
  const autonomyJson = storedCursorAutonomyJson(autonomy, {
    steps: Object.fromEntries(composition.steps.map((step) => [step.slug, step.resolvedAutonomy])),
    rulings: composition.rulings,
  })
  return {
    existingFlow,
    flowRecordId: existingFlow?.record_id ?? newRecordId(),
    projectRecordId,
    key,
    instance,
    machine,
    at,
    autonomyJson,
    rowInput: {
      recordId: newRecordId(),
      projectRecordId,
      project: composition.project,
      workflow: composition.workflow.slug,
      mode: composition.mode!.slug,
      workflowKey: key,
      taskRecordId: context.taskRecordId ?? null,
      taskFlowRecordId: null,
      instanceId: instance,
      sessionId: context.session ?? null,
      workflowVersionRecordId: composition.workflow.record_id,
      catalogueVersionRecordId: composition.catalogue.record_id,
      args: JSON.stringify(composition.arguments),
      autonomy: autonomyJson,
      ordinal: 0,
      stepSlug: composition.steps[0]!.slug,
      state: 'running',
      closed: '[]',
      question: null,
      totalSteps: composition.steps.length,
      createdAt: at,
      updatedAt: at,
      enforcement: 'floors',
      openedMachineId: machine,
      takenOverFromMachineId: null,
      lastAdvancedMachineId: machine,
      revision: 1,
    },
  }
}

function composeIntent(
  composition: Composition,
  context: WorkflowCursorContext,
  facts: ComposeFacts,
): TaskFlowIntentInput<'compose'> {
  const { existingFlow, flowRecordId, projectRecordId, rowInput, machine, at } = facts
  return {
    requestId: taskFlowRequestId('compose', [
      projectRecordId,
      composition.workflow.slug,
      composition.mode!.slug,
      facts.key,
      facts.instance,
    ]),
    ...(existingFlow
      ? {
          flowChange: {
            id: existingFlow.record_id,
            expectedRevision: existingFlow.revision,
            values: {
              openStageRecordId: rowInput.recordId,
              updatedMachineId: machine,
              updatedAt: at,
            },
          },
        }
      : {
          flowInsert: {
            id: flowRecordId,
            projectId: projectRecordId,
            taskId: context.taskRecordId ?? null,
            state: taskFlowState(context.taskStatusCategory) ?? 'open',
            openStageRecordId: rowInput.recordId,
            openingMachineId: machine,
            updatedMachineId: machine,
            createdAt: at,
            updatedAt: at,
          },
        }),
    stageInsert: {
      id: rowInput.recordId,
      flowRecordId,
      projectId: projectRecordId,
      workflow: composition.workflow.slug,
      mode: composition.mode!.slug,
      workflowKey: facts.key,
      instanceId: facts.instance,
      sessionId: context.session ?? null,
      workflowVersionId: composition.workflow.record_id,
      catalogueVersionId: composition.catalogue.record_id,
      arguments: composition.arguments,
      activeOrdinal: 0,
      activeSlug: composition.steps[0]!.slug,
      state: 'running',
      closedStepNotes: [],
      question: null,
      autonomy: facts.autonomyJson,
      enforcement: 'floors',
      totalSteps: composition.steps.length,
      openedMachineId: machine,
      takenOverFromMachineId: null,
      lastAdvancedMachineId: machine,
      createdAt: at,
      updatedAt: at,
    },
  }
}

function applyHostedCompose(
  hosted: TaskFlowComposeResult | null,
  payload: TaskFlowIntentInput<'compose'>,
  _facts: ComposeFacts,
  _composition: Composition,
  _context: WorkflowCursorContext,
  database: Database,
): SelectableCursorRow {
  return writeTransaction(() => {
    const result = taskFlowLocalStore(database).write('compose', payload, hosted)
    return taskFlowLocalStore(database).stageByRecordId(result.stage!.id) as SelectableCursorRow
  }, database)
}

function cacheComposeReplay(
  replay: Awaited<
    ReturnType<NonNullable<ReturnType<typeof recordApiClient>['listTaskFlowStages']>>
  >['items'][number],
  facts: ComposeFacts,
  composition: Composition,
  context: WorkflowCursorContext,
  database: Database,
): SelectableCursorRow {
  const { stage, flow } = replay
  return writeTransaction(() => {
    const stored = insertWorkflowCursorRow(
      database,
      {
        ...facts.rowInput,
        recordId: stage.id,
        taskRecordId: flow.taskId,
        taskFlowRecordId: flow.taskId ? flow.id : null,
        instanceId: stage.instanceId ?? facts.instance,
        sessionId: stage.sessionId ?? null,
        args: JSON.stringify(stage.arguments),
        ordinal: stage.activeOrdinal,
        stepSlug: stage.activeSlug,
        state: stage.state,
        closed: JSON.stringify(stage.closedStepNotes),
        question: stage.question ?? null,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
        revision: stage.revision,
      },
      'hosted-record',
    )
    if (flow.taskId)
      cacheAdoptedTaskFlow(
        {
          project: composition.project,
          taskRecordId: flow.taskId,
          cursorRecordId: stored,
          flowRecordId: flow.id,
          flowRevision: flow.revision,
          stageRevision: stage.revision,
          statusCategory: context.taskStatusCategory,
          at: stage.updatedAt,
        },
        database,
      )
    return taskFlowLocalStore(database).stageByRecordId(stored) as SelectableCursorRow
  }, database)
}

async function recoverComposeConflict(
  error: DocRevisionConflictError,
  facts: ComposeFacts,
  composition: Composition,
  context: WorkflowCursorContext,
  database: Database,
  autonomy: AutonomyResolution | undefined,
  commitCount: CommitCountPort,
  keylessSiblingRetry: boolean,
  target: TaskFlowWriteTarget,
): Promise<SelectableCursorRow> {
  const client = context.taskFlowClient ?? recordApiClient()
  const listed = await client.listTaskFlowStages!(
    {
      projectId: facts.projectRecordId,
      states: ['running', 'awaiting-ruling'],
      ...(facts.key ? { taskKey: facts.key } : { sessionId: context.session ?? undefined }),
    },
    await resolveTaskFlowDestination(target, client),
  )
  const replay = listed.items.find(
    ({ stage }) =>
      stage.workflow === composition.workflow.slug &&
      stage.mode === composition.mode!.slug &&
      (stage.workflowKey ?? '') === facts.key &&
      (stage.instanceId ?? '') === facts.instance,
  )
  if (!replay)
    throw new Error(
      `${error.message}; close or abandon the stage holding this workflow slot, then retry`,
    )
  const alreadyCached = await taskFlowReadStore(database, client).hasStage(replay.stage.id)
  if (!alreadyCached) return cacheComposeReplay(replay, facts, composition, context, database)
  if (facts.key || keylessSiblingRetry) throw error
  return insertWorkflowCursor(composition, context, database, autonomy, commitCount, true)
}

export async function insertWorkflowCursor(
  composition: Composition,
  context: WorkflowCursorContext,
  database: Database,
  autonomy?: AutonomyResolution,
  commitCount: CommitCountPort = readCommitsPastLanding,
  keylessSiblingRetry = false,
): Promise<SelectableCursorRow> {
  const refusal = workflowComposeBranchRefusal({
    workflow: composition.workflow.slug,
    project: composition.project,
    args: composition.arguments,
    d: database,
    commitCount,
  })
  if (refusal) throw new Error(refusal)
  const facts = await readComposeFacts(
    composition,
    context,
    autonomy,
    database,
    keylessSiblingRetry ? 1 : 0,
  )
  const target = taskFlowWriteTarget(composition.project, database)
  try {
    const payload = composeIntent(composition, context, facts)
    const hosted = await writeHostedTaskFlow('compose', payload, target, context.taskFlowClient)
    return applyHostedCompose(hosted, payload, facts, composition, context, database)
  } catch (error) {
    if (!(error instanceof DocRevisionConflictError) || error.reason !== 'already-exists')
      throw error
    return recoverComposeConflict(
      error,
      facts,
      composition,
      context,
      database,
      autonomy,
      commitCount,
      keylessSiblingRetry,
      target,
    )
  }
}
