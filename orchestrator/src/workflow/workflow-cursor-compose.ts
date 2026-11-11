// concern: workflow cursor compose
/** Owns hosted-first cursor insertion, keyless slot identity, and compose replay recovery. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { machineId } from '../record/machine-identity.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { writeHostedTaskFlow } from '../record/record-task-flow-write-client.ts'
import {
  type TaskFlowComposeResult,
  type TaskFlowIntentInput,
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import type { AutonomyResolution } from './autonomy.ts'
import {
  attachInsertedTaskFlowStage,
  cacheAdoptedTaskFlow,
  insertWorkflowCursorRow,
  refuseTaskFlowStageConflict,
  stampWorkflowCursorMachine,
  type WorkflowCursorInsert,
} from './task-flow.ts'
import { taskFlowState } from './task-flow-decision.ts'
import { resolveTaskFlowDestination } from './task-flow-hosted-destination.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
  workflowComposeBranchRefusal,
} from './workflow-compose-branch.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { storedCursorAutonomyJson } from './workflow-cursor-autonomy.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
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

function keylessComposeOrdinal(
  composition: Composition,
  context: WorkflowCursorContext,
  projectRecordId: string,
  machine: string,
  database: Database,
): number {
  return database
    .query<{ n: number }, [string, string, string, string | null, string | null, string]>(
      `SELECT COUNT(*)+1 n FROM workflow_cursor
       WHERE project_record_id=? AND workflow_slug=? AND mode_slug=? AND workflow_key=''
         AND (session_id=? OR (? IS NULL AND session_id IS NULL AND opened_machine_id=?))`,
    )
    .get(
      projectRecordId,
      composition.workflow.slug,
      composition.mode!.slug,
      context.session ?? null,
      context.session ?? null,
      machine,
    )!.n
}

function readComposeFacts(
  composition: Composition,
  context: WorkflowCursorContext,
  autonomy: AutonomyResolution | undefined,
  database: Database,
  keylessOrdinalOffset = 0,
): ComposeFacts {
  const key = workflowKeyOf(composition.arguments)
  const projectRecordId = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(composition.project)!.record_id
  const existingFlow = context.taskRecordId
    ? database
        .query<{ record_id: string; revision: number }, [string]>(
          'SELECT record_id,revision FROM task_flow WHERE task_record_id=?',
        )
        .get(context.taskRecordId)
    : null
  if (context.taskRecordId && key)
    refuseTaskFlowStageConflict(
      {
        taskRecordId: context.taskRecordId,
        taskKey: key,
        workflow: composition.workflow.slug,
        mode: composition.mode!.slug,
      },
      database,
    )
  if (key)
    refuseUnlinkedCursorLabelCollision(database, {
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
    : keylessComposeOrdinal(composition, context, projectRecordId, machine, database) +
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

function attachLocalComposition(
  row: WorkflowCloseCursor,
  composition: Composition,
  context: WorkflowCursorContext,
  database: Database,
): string | null {
  return attachInsertedTaskFlowStage(
    {
      project: composition.project,
      taskRecordId: context.taskRecordId,
      taskKey: workflowKeyOf(composition.arguments),
      statusCategory: context.taskStatusCategory,
      cursor: row,
    },
    database,
  )
}

function applyHostedCompose(
  hosted: TaskFlowComposeResult | null,
  facts: ComposeFacts,
  composition: Composition,
  context: WorkflowCursorContext,
  database: Database,
): WorkflowCloseCursor {
  const cursorRecordId = hosted?.stage?.id ?? facts.rowInput.recordId
  const flowRecordId =
    facts.existingFlow?.record_id ??
    (hosted
      ? Object.keys(hosted.revisions).find((recordId) => recordId !== cursorRecordId)
      : undefined) ??
    facts.flowRecordId
  return writeTransaction(() => {
    if (facts.existingFlow) {
      const current = database
        .query<{ revision: number }, [string]>('SELECT revision FROM task_flow WHERE record_id=?')
        .get(facts.existingFlow.record_id)
      if (!current || current.revision !== facts.existingFlow.revision)
        throw new Error(
          `task flow ${facts.existingFlow.record_id} changed while composing; rerun the command`,
        )
    }
    const stored = insertWorkflowCursorRow(
      database,
      {
        ...facts.rowInput,
        recordId: cursorRecordId,
        number: hosted?.stage?.number,
        revision: hosted?.revisions[cursorRecordId] ?? 1,
      },
      'local-identity',
    )
    if (hosted && context.taskRecordId)
      cacheAdoptedTaskFlow(
        {
          project: composition.project,
          taskRecordId: context.taskRecordId,
          cursorRecordId: stored,
          flowRecordId,
          flowRevision: hosted.revisions[flowRecordId]!,
          stageRevision: hosted.revisions[cursorRecordId]!,
          statusCategory: context.taskStatusCategory,
          at: facts.at,
        },
        database,
      )
    if (!hosted) {
      stampWorkflowCursorMachine(stored, stored === facts.rowInput.recordId ? 0 : 1, database)
      const local = database
        .query('SELECT number id,* FROM workflow_cursor WHERE record_id=?')
        .get(stored) as WorkflowCloseCursor
      local.task_flow_record_id = attachLocalComposition(local, composition, context, database)
    }
    return database
      .query('SELECT number id,* FROM workflow_cursor WHERE record_id=?')
      .get(stored) as WorkflowCloseCursor
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
): WorkflowCloseCursor {
  const { stage, flow } = replay
  return writeTransaction(() => {
    const stored = insertWorkflowCursorRow(
      database,
      {
        ...facts.rowInput,
        recordId: stage.id,
        number: stage.number ?? undefined,
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
    return database
      .query('SELECT number id,* FROM workflow_cursor WHERE record_id=?')
      .get(stored) as WorkflowCloseCursor
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
  destination: Awaited<ReturnType<typeof resolveTaskFlowDestination>>,
): Promise<WorkflowCloseCursor> {
  const client = context.taskFlowClient ?? recordApiClient()
  const listed = await client.listTaskFlowStages!(
    {
      projectId: facts.projectRecordId,
      states: ['running', 'awaiting-ruling'],
      ...(facts.key ? { taskKey: facts.key } : { sessionId: context.session ?? undefined }),
    },
    destination,
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
  const alreadyCached = database
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM workflow_cursor WHERE record_id=?',
    )
    .get(replay.stage.id)
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
): Promise<WorkflowCloseCursor> {
  const refusal = workflowComposeBranchRefusal({
    workflow: composition.workflow.slug,
    project: composition.project,
    args: composition.arguments,
    d: database,
    commitCount,
  })
  if (refusal) throw new Error(refusal)
  const facts = readComposeFacts(
    composition,
    context,
    autonomy,
    database,
    keylessSiblingRetry ? 1 : 0,
  )
  const destination = await resolveTaskFlowDestination(
    composition.project,
    database,
    context.taskFlowClient,
  )
  try {
    const hosted = await writeHostedTaskFlow(
      'compose',
      composeIntent(composition, context, facts),
      destination,
      context.taskFlowClient,
    )
    return applyHostedCompose(hosted, facts, composition, context, database)
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
      destination,
    )
  }
}
