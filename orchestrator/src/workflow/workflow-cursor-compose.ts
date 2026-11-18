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
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import type { AutonomyResolution } from './autonomy.ts'
import { exploreGraduation } from './explore-graduation.ts'
import { refuseTaskFlowStageConflict } from './task-flow.ts'
import { taskFlowState } from './task-flow-decision.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { stageRow } from './task-flow-store-record-stage-row.ts'
import { sqliteTaskFlowLocalStore } from './task-flow-store-sqlite.ts'
import {
  isKeylessExplore,
  type TaskFlowIntentInput,
  type WorkflowCursorInsert,
  workflowStageInsert,
} from './task-flow-store-types.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
  workflowComposeBranchRefusal,
} from './workflow-compose-branch.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { storedCursorAutonomyForComposition } from './workflow-cursor-autonomy.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { refuseUnlinkedCursorLabelCollision } from './workflow-cursor-task-reference.ts'
import { cursorOwnerAfter } from './workflow-cursor-transition.ts'
import {
  closeExploreForLifecycle,
  type FinishExploreLifecycle,
} from './workflow-explore-lifecycle-close.ts'
import type { GraduatedExplore } from './workflow-handoff-types.ts'
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

export async function graduatingExploreCursor(input: {
  project: string
  session: string | null | undefined
  taskBound: boolean
  database: Database
  taskFlowClient?: WorkflowCursorContext['taskFlowClient']
}): Promise<SelectableCursorRow | undefined> {
  if (!input.session || !input.taskBound) return undefined
  const rows = await taskFlowReadStore(input.database, input.taskFlowClient).listOpenStages({
    project: input.project,
    sessionId: input.session,
  })
  const row = rows.find(isKeylessExplore)
  const explore = row
    ? {
        cursor: row.id,
        recordId: row.record_id,
        closedSteps: JSON.parse(row.closed).length,
        hasOpenQuestion: row.question_number !== null,
        attachedText: (
          await taskFlowReadStore(input.database, input.taskFlowClient).textsForStage(row.record_id)
        ).length,
      }
    : null
  const decision = exploreGraduation({ taskBound: input.taskBound, explore })
  if (decision.action === 'keep') return undefined
  return row
}

export async function closeGraduatingExploreForReuse(
  composition: ReturnType<typeof composeWorkflow>,
  context: WorkflowCursorContext,
  database: Database,
  finish: FinishExploreLifecycle,
  replacingCursor: number,
): Promise<GraduatedExplore | undefined> {
  const source = await graduatingExploreCursor({
    project: composition.project,
    session: context.session,
    taskBound: Boolean(workflowKeyOf(composition.arguments)),
    database,
    taskFlowClient: context.taskFlowClient,
  })
  if (!source) return undefined
  try {
    const outcome = await closeExploreForLifecycle(
      source.record_id,
      'answered',
      database,
      finish,
      `replaced by cursor ${replacingCursor}`,
      { requireUntouched: true },
    )
    return outcome === 'closed'
      ? { cursor: source.id, closed: true }
      : {
          cursor: source.id,
          closed: false,
          reason: `close outcome was ${outcome}`,
        }
  } catch (error) {
    return {
      cursor: source.id,
      closed: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
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
  return taskFlowReadStore(database, context.taskFlowClient).nextKeylessInstanceSlot(input)
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
    ? await taskFlowReadStore(database, context.taskFlowClient).flowForTask(context.taskRecordId)
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
      context.taskFlowClient,
    )
  if (key)
    await refuseUnlinkedCursorLabelCollision(
      database,
      {
        project: composition.project,
        workflow: composition.workflow.slug,
        mode: composition.mode!.slug,
        key,
        taskRecordId: context.taskRecordId,
      },
      context.taskFlowClient,
    )
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
  const autonomyJson = storedCursorAutonomyForComposition(autonomy, composition)
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
      sessionId: cursorOwnerAfter('compose', null, context.session),
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
    stageInsert: workflowStageInsert({
      id: rowInput.recordId,
      flowRecordId,
      projectId: projectRecordId,
      workflow: composition.workflow.slug,
      mode: composition.mode!.slug,
      workflowKey: facts.key,
      instanceId: facts.instance,
      sessionId: cursorOwnerAfter('compose', null, context.session),
      workflowVersionId: composition.workflow.record_id,
      catalogueVersionId: composition.catalogue.record_id,
      arguments: composition.arguments,
      activeSlug: composition.steps[0]!.slug,
      autonomy: facts.autonomyJson,
      totalSteps: composition.steps.length,
      openedMachineId: machine,
      createdAt: at,
    }),
  }
}

function applyHostedCompose(
  hosted: TaskFlowComposeResult | null,
  payload: TaskFlowIntentInput<'compose'>,
  facts: ComposeFacts,
  composition: Composition,
  database: Database,
): SelectableCursorRow {
  if (hosted?.stage) {
    const { rowInput } = facts
    return {
      id: hosted.stage.number,
      record_id: hosted.stage.id,
      project: rowInput.project,
      workflow_slug: rowInput.workflow,
      mode_slug: rowInput.mode,
      workflow_key: rowInput.workflowKey,
      task_record_id: rowInput.taskRecordId,
      task_flow_record_id: facts.flowRecordId,
      instance_id: rowInput.instanceId,
      session_id: rowInput.sessionId,
      ordinal: rowInput.ordinal,
      step_slug: rowInput.stepSlug,
      state: rowInput.state as SelectableCursorRow['state'],
      workflow_version_record_id: rowInput.workflowVersionRecordId,
      catalogue_version_record_id: rowInput.catalogueVersionRecordId,
      workflow_version: composition.workflow.version,
      catalogue_version: composition.catalogue.version,
      args: rowInput.args,
      autonomy: rowInput.autonomy,
      closed: rowInput.closed,
      question: rowInput.question,
      total_steps: rowInput.totalSteps,
      created_at: rowInput.createdAt,
      enforcement: rowInput.enforcement as SelectableCursorRow['enforcement'],
      opened_machine_id: rowInput.openedMachineId,
      taken_over_from_machine_id: rowInput.takenOverFromMachineId,
      last_advanced_machine_id: rowInput.lastAdvancedMachineId,
      handed_off_from_record_id: null,
      revision: hosted.revisions[hosted.stage.id]!,
      updated_at: rowInput.updatedAt,
    }
  }
  return writeTransaction(() => {
    const result = taskFlowLocalStore(database).write('compose', payload, hosted)
    return sqliteTaskFlowLocalStore(database).stageByRecordId(
      result.stage!.id,
    ) as SelectableCursorRow
  }, database)
}

function cacheComposeReplay(
  replay: Awaited<
    ReturnType<NonNullable<ReturnType<typeof recordApiClient>['listTaskFlowStages']>>
  >['items'][number],
): SelectableCursorRow {
  const { stage, flow } = replay
  return stageRow({ stage, flow })
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
  if (!alreadyCached) return cacheComposeReplay(replay)
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
    return applyHostedCompose(hosted, payload, facts, composition, database)
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
