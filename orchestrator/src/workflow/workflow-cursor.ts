import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { notifyWaitingItem } from '../operator/operator-waiting.ts'
import { projectByName } from '../project/projects.ts'
import { maximumQuestionNumber } from '../question-store/question-store-read.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import {
  type TaskFlowIntentResult,
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import { upsertWorkflowQuestion } from '../run/question-mutation.ts'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { decideWorkflowTakeover, workflowTakeoverNotice } from './task-flow-decision.ts'
import {
  taskFlowLocalStore,
  taskFlowReadStore,
  taskFlowWritesHosted,
  writeLocalAdvance,
} from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
  workflowComposeBranchRefusal,
} from './workflow-compose-branch.ts'
import { followComposeTaskClaim } from './workflow-compose-claim.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import { workflowKeyOf as keyOf, resolveCursorArguments } from './workflow-cursor-arguments.ts'
import {
  closeGraduatingExploreForReuse,
  insertWorkflowCursor,
  type WorkflowComposeInheritance,
} from './workflow-cursor-compose.ts'
import { cursorName } from './workflow-cursor-format.ts'
import { abandonWorkflowCursor, closeOpenWorkflowQuestion } from './workflow-cursor-mutation.ts'
import {
  persistedAdvanceRenderFailure,
  refuseMissingAbandonReason,
  refuseMissingCloseNote,
  refuseTerminalCursor,
  renderWorkflowAdvanceResult,
} from './workflow-cursor-result.ts'
import {
  findWorkflowCursor,
  readThroughWorkflowCursorContext,
  type SelectableCursorRow,
  selectByHandle,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'
import { type ClosedStep, type CursorTrailEntry, isClosedStep } from './workflow-cursor-trail.ts'
import {
  cursorOwnerAfter,
  decideConditionalAdvance,
  decideCursorStart,
  decideStepOutcome,
} from './workflow-cursor-transition.ts'
import type { WorkflowEvidenceInput } from './workflow-evidence-input.ts'
import { refuseFinishWithLiveWriter } from './workflow-finish-live-writer-adapter.ts'
import {
  allowedCloseFloor,
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  decideCloseFloors,
  type Floor,
  type FloorDecision,
} from './workflow-floor.ts'
import { applyFloorDecision, refuseForeignKeylessCursor } from './workflow-floor-apply.ts'
import { type FloorEvidencePorts, productionFloorPorts } from './workflow-floor-evidence.ts'
import { withReplayedFloorEvidenceAsync } from './workflow-floor-evidence-replay.ts'
import { handoffGraduatingExplore } from './workflow-handoff.ts'
import type { CursorSummary } from './workflow-handoff-types.ts'
import { refuseKeylessStepClose } from './workflow-keyless-close.ts'
import { selfRulingRefusal } from './workflow-self-ruling.ts'
import {
  recordWorkflowSelfRuling,
  type WorkflowSelfRulingInput,
} from './workflow-self-ruling-mutation.ts'
import {
  followTaskCursorClaim,
  type TaskCursorClaimPorts,
  taskClaimFollowWarning,
  taskClaimReleaseWarning,
} from './workflow-task-claim.ts'
import { linkResolvedWorkflowTask, withLinkedWorkflowTask } from './workflow-task-linking.ts'
import { workflowTextDeletionIds } from './workflow-text.ts'
import { composeWorkflow } from './workflows.ts'

type CursorRow = SelectableCursorRow

/** Re-reads, inside the close transaction, a cursor selected before its text copy. */
async function reselectCursor(
  selected: SelectableCursorRow,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  d: Database,
): Promise<CursorRow> {
  const row = (await selectByHandle(
    selected.id,
    {
      project: selected.project,
      workflow: selected.workflow_slug,
      mode: selected.mode_slug,
      key: selected.workflow_key || undefined,
    },
    d,
    true,
    context.taskFlowClient,
  )) as CursorRow
  const moved =
    row.updated_at !== selected.updated_at ||
    row.state !== selected.state ||
    row.ordinal !== selected.ordinal ||
    row.step_slug !== selected.step_slug
  if (moved) {
    refuseTerminalCursor(row)
    throw new Error(
      `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} changed while its attached text was copied; run the close again`,
    )
  }
  adoptLinkedTask(row, args, context)
  return row
}

function adoptLinkedTask(
  row: CursorRow,
  args: Record<string, string>,
  context: WorkflowCursorContext,
): void {
  if (!row.task_record_id && keyOf(args) && context.taskRecordId)
    row.task_record_id = context.taskRecordId
}

const takenOverFrom = (row: CursorRow | null, context: WorkflowCursorContext): string | null =>
  row?.session_id && context.session && row.session_id !== context.session ? row.session_id : null

async function refuseLocalComposeBranch(
  composition: {
    project: string
    workflow: { slug: string }
    mode: { slug: string }
    arguments: Record<string, string>
  },
  context: WorkflowCursorContext,
  database: Database,
  commitCount: CommitCountPort,
): Promise<void> {
  const existing = keyOf(composition.arguments)
    ? await findWorkflowCursor(
        composition.project,
        composition.workflow.slug,
        composition.mode.slug,
        composition.arguments,
        context,
        database,
      )
    : null
  if (decideCursorStart(existing?.state ?? null) === 'reuse') return
  const refusal = workflowComposeBranchRefusal({
    workflow: composition.workflow.slug,
    project: composition.project,
    args: composition.arguments,
    d: database,
    commitCount,
  })
  if (refusal) throw new Error(refusal)
}

async function reuseWorkflowCursor(
  existing: CursorRow,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  database: Database,
): Promise<CursorRow> {
  const resolved = resolveCursorArguments(existing, args, database, true)
  const payload: TaskFlowIntentInput<'stage-update'> = {
    requestId: taskFlowRequestId('stage-update', [existing.record_id, String(existing.revision)]),
    stages: [
      {
        id: existing.record_id,
        expectedRevision: existing.revision,
        values: {
          arguments: resolved.args,
          closedStepNotes: JSON.parse(resolved.closed) as unknown[],
          sessionId: cursorOwnerAfter('compose', existing.session_id, context.session),
          updatedAt: resolved.updatedAt,
        },
      },
    ],
  }
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    payload,
    taskFlowWriteTarget(existing.project, database),
    context.taskFlowClient,
  )
  let row!: CursorRow
  writeTransaction(() => {
    const result = taskFlowLocalStore(database).write('stage-update', payload, hosted)
    row = {
      ...existing,
      args: resolved.encoded,
      closed: resolved.closed,
      session_id: context.session ?? existing.session_id,
      updated_at: resolved.updatedAt,
      revision: result.revisions[existing.record_id]!,
    }
  }, database)
  return row
}

export async function composeWorkflowWithCursor(
  slug: string,
  project: string,
  mode: string | undefined,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  d: Database = db(),
  selection: { version?: number; catalogueVersion?: number } = {},
  live: LiveCursorAutonomy,
  commitCount: CommitCountPort = readCommitsPastLanding,
  taskClaimPorts?: TaskCursorClaimPorts,
  inheritance?: WorkflowComposeInheritance,
) {
  const shape = composeWorkflow(slug, project, mode, args, d, selection)
  if (!shape.mode || shape.needs.arguments) return { ...shape, cursor: null, graduated: undefined }
  await refuseLocalComposeBranch(
    {
      project: shape.project,
      workflow: shape.workflow,
      mode: shape.mode,
      arguments: shape.arguments,
    },
    context,
    d,
    commitCount,
  )
  await readThroughWorkflowCursorContext(project, context, d)
  await linkResolvedWorkflowTask(project, context, d)
  const existing = keyOf(shape.arguments)
    ? await findWorkflowCursor(
        shape.project,
        shape.workflow.slug,
        shape.mode.slug,
        shape.arguments,
        context,
        d,
      )
    : null
  const start = decideCursorStart(existing?.state ?? null)
  const composition =
    start === 'reuse'
      ? shape
      : composeWorkflow(slug, project, mode, args, d, selection, live.resolution)
  const handedOff =
    start === 'reuse'
      ? undefined
      : await handoffGraduatingExplore(composition, context, d, live, commitCount, taskClaimPorts)
  let row!: CursorRow
  if (handedOff) row = handedOff.row
  else if (existing && start === 'reuse')
    row = await reuseWorkflowCursor(existing, args, context, d)
  else
    row = await insertWorkflowCursor(
      composition,
      context,
      d,
      live.resolution,
      commitCount,
      false,
      inheritance,
    )
  const claimWarning = handedOff
    ? handedOff.claimWarning
    : await followComposeTaskClaim(row, start === 'reuse', context, d, taskClaimPorts)
  const cursor = {
    id: row.id,
    n: row.ordinal + 1,
    slug: row.step_slug,
    state: row.state,
    opened: Boolean(handedOff) || start !== 'reuse',
    previousSession: !handedOff && start === 'reuse' ? takenOverFrom(existing, context) : null,
  } satisfies CursorSummary
  const graduated =
    handedOff?.graduated ??
    (start === 'reuse'
      ? await closeGraduatingExploreForReuse(
          composition,
          context,
          d,
          writeFinishingWorkflowAdvance,
          cursor.id,
        )
      : undefined)
  return {
    ...cursorComposition(row, d, live),
    cursor,
    ...(claimWarning ? { claimWarning } : {}),
    graduated,
  }
}

function persistFloorClose(
  row: CursorRow,
  decision: Extract<FloorDecision, { action: 'allow' }>,
  floors: Floor[],
  at: string,
): Pick<ClosedStep, 'evidence' | 'deferred' | 'satisfied'> & {
  obligationInsert?: Record<string, unknown>
  obligationUpdate?: Record<string, unknown>
} {
  let deferred: ClosedStep['deferred']
  let obligationInsert: Record<string, unknown> | undefined
  if (decision.defer) {
    const floor = floors.find((item) => item.kind === decision.defer?.floor)
    const id = newRecordId()
    deferred = { id, floor: decision.defer.floor, reason: decision.defer.reason }
    obligationInsert = {
      id,
      stageRecordId: row.record_id,
      stepOrdinal: row.ordinal + 1,
      stepSlug: row.step_slug,
      floor: decision.defer.floor,
      requirePullRequest: Boolean(floor?.requirePullRequest),
      expectedExitCode: floor?.expectedExitCode ?? DEFAULT_EXPECTED_EXIT_CODE,
      expectedStatus: floor?.expectedStatus ?? DEFAULT_EXPECTED_STATUS,
      floorDeferrable: Boolean(floor?.deferrable),
      reason: decision.defer.reason,
      sessionId: row.session_id,
      createdAt: at,
      satisfiedAt: null,
      satisfiedStepOrdinal: null,
      satisfiedStepSlug: null,
      satisfiedEvidence: null,
      abandonedAt: null,
      abandonedReason: null,
      operatorRuling: Boolean(floor?.operatorRuling),
    }
  }
  return {
    ...(decision.refs.length ? { evidence: decision.refs } : {}),
    ...(deferred ? { deferred } : {}),
    ...(decision.satisfyId ? { satisfied: decision.satisfyId } : {}),
    ...(obligationInsert ? { obligationInsert } : {}),
    ...(decision.satisfyId
      ? {
          obligationUpdate: {
            id: decision.satisfyId,
            stageRecordId: row.record_id,
            satisfiedAt: at,
            satisfiedStepOrdinal: row.ordinal + 1,
            satisfiedStepSlug: row.step_slug,
            satisfiedEvidence: decision.refs,
          },
        }
      : {}),
  }
}

function appendWorkflowClose(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  closed: CursorTrailEntry[],
  note: string,
  outcome: string | undefined,
  floor: Extract<FloorDecision, { action: 'allow' }>,
  floors: Floor[],
  skipped: ReturnType<typeof decideConditionalAdvance>['skipped'],
  reentered: ReturnType<typeof decideConditionalAdvance>['reentered'],
  at: string,
): { obligationInsert?: Record<string, unknown>; obligationUpdate?: Record<string, unknown> } {
  const review = composition.steps[row.ordinal]?.resolvedAutonomy.value === 'review'
  const floorPersistence = persistFloorClose(row, floor, floors, at)
  const { obligationInsert, obligationUpdate, ...trailFields } = floorPersistence
  closed.push({
    n: row.ordinal + 1,
    slug: row.step_slug,
    note,
    at,
    ...(outcome ? { outcome } : {}),
    ...(reentered ? { reentered } : {}),
    ...(review ? { review: true as const } : {}),
    ...trailFields,
  })
  for (const skippedStep of skipped) {
    const condition = skippedStep.step.when!
    closed.push({
      n: skippedStep.ordinal + 1,
      slug: skippedStep.step.slug,
      note: `skipped: only when ${condition.step} is ${condition.outcome.join(' or ')}`,
      at,
      skipped: condition,
    })
  }
  return { obligationInsert, obligationUpdate }
}

async function closeFloorsForStep(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  selfRuling: WorkflowSelfRulingInput | undefined,
  outcome: string | undefined,
  d: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
  callerSession?: string | null,
) {
  const currentStep = composition.steps[row.ordinal]!
  const outcomeDecision = decideStepOutcome(currentStep.slug, currentStep.outcomes, outcome)
  if (outcomeDecision.action === 'refuse') throw new Error(outcomeDecision.message)
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  const advance = decideConditionalAdvance(
    composition.steps,
    closed.filter(isClosedStep),
    row.ordinal,
    outcome,
  )
  const floors = decideCloseFloors(currentStep, outcome, advance.requireRuling)
  let selfRulingPlan: Parameters<typeof recordWorkflowSelfRuling>[0] | undefined
  let selfRulingQuestionNumber: number | undefined
  let floorEvidence = evidence
  if (selfRuling) {
    if (evidence.ruling !== undefined)
      throw new Error('--self-ruling and --ruling are mutually exclusive')
    const refusal = selfRulingRefusal(
      currentStep.resolvedAutonomy.value,
      floors,
      selfRuling.basis.trim(),
      row.ordinal + 1,
      row.step_slug,
    )
    if (refusal) throw new Error(refusal)
    selfRulingQuestionNumber = (await maximumQuestionNumber(d)) + 1
    floorEvidence = evidence
    selfRulingPlan = {
      cursorId: row.record_id,
      projectId: projectByName(row.project, d)?.recordId ?? null,
      workflowKey: row.workflow_key,
      workflowTaskRecordId: row.task_record_id,
      cursorOrdinal: row.ordinal,
      stepSlug: row.step_slug,
      stepTitle: currentStep.title,
      resolvedAutonomy: currentStep.resolvedAutonomy.value,
      floors,
      selfRuling,
    }
  }
  const floor = allowedCloseFloor(
    await applyFloorDecision(
      row,
      floors,
      floorEvidence,
      ports,
      advance.ordinal === null,
      d,
      client,
      advance.requireRuling,
      selfRulingQuestionNumber,
      callerSession,
    ),
    advance.requireRuling,
    currentStep,
  )
  return { closed, advance, floors, floor, selfRulingPlan, selfRulingQuestionNumber }
}

async function persistWorkflowAdvance(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  closed: CursorTrailEntry[],
  note: string,
  outcome: string | undefined,
  floor: Extract<FloorDecision, { action: 'allow' }>,
  floors: Floor[],
  advance: ReturnType<typeof decideConditionalAdvance>,
  context: WorkflowCursorContext,
  d: Database,
  takeoverFromMachineId: string | null,
  selfRulingPlan?: Parameters<typeof recordWorkflowSelfRuling>[0],
): Promise<string | null> {
  const at = nowIso()
  const obligationPlan = appendWorkflowClose(
    row,
    composition,
    closed,
    note,
    outcome,
    floor,
    floors,
    advance.skipped,
    advance.reentered,
    at,
  )
  const finishing = advance.ordinal === null
  const next = finishing ? null : composition.steps[advance.ordinal as number]!
  const deleteTextIds = await advanceTextDeletionIds(
    row,
    composition,
    finishing,
    d,
    context.taskFlowClient,
  )
  if (finishing) {
    return await writeFinishingWorkflowAdvance({
      row,
      closed,
      deleteTextIds,
      obligationPlan,
      callerSession: context.session,
      takeoverFromMachineId,
      database: d,
      taskFlowClient: context.taskFlowClient,
      selfRulingPlan,
      at,
    })
  }
  const { parts, obligationInserts, obligationUpdates } = advanceRecordRows(
    row,
    null,
    obligationPlan,
  )
  const payload: TaskFlowIntentInput<'advance'> = {
    requestId: taskFlowRequestId('advance', parts),
    stage: {
      id: row.record_id,
      expectedRevision: row.revision,
      values: {
        arguments: JSON.parse(row.args) as Record<string, string>,
        activeOrdinal: advance.ordinal!,
        activeSlug: next!.slug,
        state: 'running',
        closedStepNotes: closed,
        question: null,
        sessionId: cursorOwnerAfter('advance', row.session_id, context.session),
        takenOverFromMachineId: takeoverFromMachineId,
        lastAdvancedMachineId: machineId(),
        updatedAt: at,
      },
    },
    obligationInserts,
    obligationUpdates,
    deleteTextIds,
  }
  await prepareWorkflowSelfRuling(selfRulingPlan, payload, d)
  const hosted = await writeHostedTaskFlow(
    'advance',
    payload,
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  await applyWorkflowAdvanceLocally({
    row,
    at,
    database: d,
    payload,
    hosted,
  })
  return null
}

export async function writeFinishingWorkflowAdvance(input: {
  row: SelectableCursorRow
  closed: CursorTrailEntry[]
  deleteTextIds: string[]
  obligationPlan?: ReturnType<typeof appendWorkflowClose>
  callerSession: string | null | undefined
  takeoverFromMachineId?: string | null
  database: Database
  taskFlowClient?: WorkflowCursorContext['taskFlowClient']
  selfRulingPlan?: Parameters<typeof recordWorkflowSelfRuling>[0]
  at?: string
}): Promise<string | null> {
  const { row, database, closed, deleteTextIds } = input
  const at = input.at ?? nowIso()
  const flow = await selectClosingTaskFlow(row, database, input.taskFlowClient)
  const closingFlow = flow?.open_stage_cursor_record_id === row.record_id ? flow : null
  const { parts, obligationInserts, obligationUpdates } = advanceRecordRows(
    row,
    closingFlow,
    input.obligationPlan ?? {},
  )
  const payload: TaskFlowIntentInput<'advance'> = {
    requestId: taskFlowRequestId('advance', parts),
    stage: {
      id: row.record_id,
      expectedRevision: row.revision,
      values: {
        arguments: JSON.parse(row.args) as Record<string, string>,
        activeOrdinal: row.ordinal,
        activeSlug: row.step_slug,
        state: 'done',
        closedStepNotes: closed,
        question: null,
        sessionId: cursorOwnerAfter('advance', row.session_id, input.callerSession),
        takenOverFromMachineId: input.takeoverFromMachineId,
        lastAdvancedMachineId: machineId(),
        updatedAt: at,
      },
    },
    ...(closingFlow
      ? {
          flow: {
            id: closingFlow.record_id,
            expectedRevision: closingFlow.revision,
            values: {
              openStageRecordId: null,
              updatedMachineId: machineId(),
              updatedAt: at,
            },
          },
        }
      : {}),
    obligationInserts,
    obligationUpdates,
    deleteTextIds,
  }
  await prepareWorkflowSelfRuling(input.selfRulingPlan, payload, database)
  const hosted = await writeHostedTaskFlow(
    'advance',
    payload,
    taskFlowWriteTarget(row.project, database),
    input.taskFlowClient,
  )
  await applyWorkflowAdvanceLocally({
    row,
    at,
    database,
    payload,
    hosted,
  })
  try {
    await followTaskCursorClaim({
      project: row.project,
      taskKey: row.workflow_key || null,
      session: input.callerSession,
      verb: 'finish',
      database,
    })
    return null
  } catch (error) {
    return row.workflow_key ? taskClaimReleaseWarning(row.project, row.workflow_key, error) : null
  }
}

async function selectClosingTaskFlow(
  row: CursorRow,
  database: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
) {
  if (!row.task_flow_record_id) return null
  return await taskFlowReadStore(database, client).flowState(row.task_flow_record_id)
}

async function advanceTextDeletionIds(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  finishing: boolean,
  database: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
): Promise<string[]> {
  if (!finishing && !composition.steps[row.ordinal]!.needs.includes('workflow-text')) return []
  return await workflowTextDeletionIds(row.record_id, Boolean(row.task_record_id), database, client)
}

function advanceRecordRows(
  row: CursorRow,
  flow: { record_id: string; revision: number } | null,
  obligationPlan: ReturnType<typeof appendWorkflowClose>,
): {
  parts: string[]
  obligationInserts: NonNullable<TaskFlowIntentInput<'advance'>['obligationInserts']>
  obligationUpdates: NonNullable<TaskFlowIntentInput<'advance'>['obligationUpdates']>
} {
  const rows = [
    { id: row.record_id, revision: row.revision },
    ...(flow ? [{ id: flow.record_id, revision: flow.revision }] : []),
  ]
  const obligationInserts = obligationPlan.obligationInsert ? [obligationPlan.obligationInsert] : []
  const obligationUpdates = obligationPlan.obligationUpdate ? [obligationPlan.obligationUpdate] : []
  return {
    parts: rows
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap(({ id, revision }) => [id, String(revision)]),
    obligationInserts: obligationInserts as NonNullable<
      TaskFlowIntentInput<'advance'>['obligationInserts']
    >,
    obligationUpdates: obligationUpdates as NonNullable<
      TaskFlowIntentInput<'advance'>['obligationUpdates']
    >,
  }
}

async function prepareWorkflowSelfRuling(
  plan: Parameters<typeof recordWorkflowSelfRuling>[0] | undefined,
  payload: TaskFlowIntentInput<'advance'>,
  database: Database,
): Promise<void> {
  if (!plan) return
  if (!taskFlowWritesHosted(database)) {
    // Record the ruling only once the local advance is known to apply.
    database.exec('SAVEPOINT self_ruling_preflight')
    try {
      writeLocalAdvance(database, payload, null)
    } finally {
      database.exec('ROLLBACK TO self_ruling_preflight; RELEASE self_ruling_preflight')
    }
  }
  await recordWorkflowSelfRuling(plan, database)
}

async function applyWorkflowAdvanceLocally(input: {
  row: SelectableCursorRow
  at: string
  database: Database
  payload: TaskFlowIntentInput<'advance'>
  hosted: TaskFlowIntentResult<'advance'> | null
}): Promise<void> {
  const { row, at, database: d, payload, hosted } = input
  if (row.state === 'awaiting-ruling')
    await closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', at, d)
  writeTransaction(() => writeLocalAdvance(d, payload, hosted), d)
}

async function adoptAndRefreshWorkflowTask(
  row: CursorRow,
  task: WorkflowEvidenceInput['task'],
  context: WorkflowCursorContext,
  database: Database,
): Promise<CursorRow> {
  const workflowKey = row.workflow_key
  await adoptWorkflowTask(
    row,
    task,
    context.adoptionTaskRecordId ?? context.taskRecordId,
    database,
    context.taskFlowClient,
    context.taskStatusCategory,
  )
  if (row.workflow_key === workflowKey) return row
  return (await taskFlowReadStore(database, context.taskFlowClient).stageByRecordId(
    row.record_id,
  )) as CursorRow
}

function workflowTakeoverForAdvance(
  row: CursorRow,
  context: WorkflowCursorContext,
): { notice: string | null; fromMachineId: string | null } {
  if (!row.task_flow_record_id || !row.last_advanced_machine_id)
    return { notice: null, fromMachineId: null }
  const decision = decideWorkflowTakeover({
    currentMachineId: machineId(),
    holderMachineId: row.last_advanced_machine_id,
    recordRead: context.taskFlowRead?.status ?? 'not-attempted',
    recordRemedy:
      context.taskFlowRead?.status === 'unreachable' ? context.taskFlowRead.remedy : undefined,
    workflowKey: row.workflow_key,
  })
  const holderName =
    context.taskFlowRead?.status === 'reachable' && context.taskFlowRead.holder
      ? context.taskFlowRead.holder.displayName
      : row.last_advanced_machine_id
  if (decision.action === 'refuse')
    throw new Error(`workflow stage is held by ${holderName}; ${decision.remedy}`)
  return decision.action === 'take-over'
    ? { notice: workflowTakeoverNotice(holderName), fromMachineId: decision.fromMachineId }
    : { notice: null, fromMachineId: null }
}

async function nextWorkflowStepImpl(
  row: CursorRow,
  args: Record<string, string>,
  note: string | undefined,
  context: WorkflowCursorContext,
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  d: Database = writableDb(),
  selfRuling?: WorkflowSelfRulingInput,
  outcome?: string,
  live?: LiveCursorAutonomy,
): Promise<WorkflowAdvanceResult> {
  const { workflow_slug: slug, project, mode_slug: mode } = row
  const takeover = workflowTakeoverForAdvance(row, context)
  refuseTerminalCursor(row)
  const resolvedArguments = resolveCursorArguments(row, args, d)
  row.args = resolvedArguments.encoded
  row.closed = resolvedArguments.closed
  refuseKeylessStepClose(row, evidence.task, d, live)
  refuseForeignKeylessCursor(row, context.session)
  row = await adoptAndRefreshWorkflowTask(row, evidence.task, context, d)
  const composition = cursorComposition(row, d, live)
  const step = composition.steps[row.ordinal]!
  refuseMissingCloseNote(note, step.n, step.slug)
  const close = await closeFloorsForStep(
    row,
    composition,
    evidence,
    ports,
    selfRuling,
    outcome,
    d,
    context.taskFlowClient,
    context.session,
  )
  refuseFinishWithLiveWriter(d, row, close.advance.ordinal === null, context.session)
  let claimWarning = await persistWorkflowAdvance(
    row,
    composition,
    close.closed,
    note.trim(),
    outcome,
    close.floor,
    close.floors,
    close.advance,
    context,
    d,
    takeover.fromMachineId,
    close.selfRulingPlan,
  )
  if (close.advance.ordinal !== null) {
    try {
      await followTaskCursorClaim({
        project: row.project,
        taskKey: row.workflow_key || null,
        session: context.session,
        verb: 'advance',
        database: d,
      })
    } catch (error) {
      if (row.workflow_key) claimWarning = taskClaimFollowWarning(row.workflow_key, error)
    }
  }
  let rendered: string
  try {
    rendered = await renderWorkflowAdvanceResult({
      row,
      composition,
      closed: close.closed,
      advance: close.advance,
      slug,
      project,
      mode,
      selfRuling,
      d,
      client: context.taskFlowClient,
      live,
    })
  } catch (error) {
    if (close.advance.ordinal === null) throw error
    const active = composition.steps[close.advance.ordinal]!
    throw persistedAdvanceRenderFailure({ row, closed: step, active, error })
  }
  return {
    text: [takeover.notice, rendered, claimWarning].filter(Boolean).join('\n'),
    selfRulingQuestionNumber: close.selfRulingQuestionNumber,
    cursorNumber: row.id,
    cursorRecordId: row.record_id,
    workflowKey: row.workflow_key || null,
    finished: close.advance.ordinal === null,
    stepSlug:
      close.advance.ordinal === null ? undefined : composition.steps[close.advance.ordinal]!.slug,
    stepTitle:
      close.advance.ordinal === null ? undefined : composition.steps[close.advance.ordinal]!.title,
  }
}

export type WorkflowAdvanceResult = {
  text: string
  selfRulingQuestionNumber?: number
  cursorNumber: number
  cursorRecordId: string
  workflowKey: string | null
  finished: boolean
  stepSlug?: string
  stepTitle?: string
}

export async function nextWorkflowStep(
  selected: SelectableCursorRow,
  project: string,
  args: Record<string, string>,
  note: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  evidence: WorkflowEvidenceInput = {},
  ports: FloorEvidencePorts = productionFloorPorts(),
  selfRuling?: WorkflowSelfRulingInput,
  outcome?: string,
  live?: LiveCursorAutonomy,
): Promise<WorkflowAdvanceResult> {
  await linkResolvedWorkflowTask(project, context, d)
  await reselectCursor(selected, args, context, d)
  return withReplayedFloorEvidenceAsync(ports, async (replayPorts) => {
    const row = (await taskFlowReadStore(d, context.taskFlowClient).stageByRecordId(
      selected.record_id,
    )) as CursorRow
    adoptLinkedTask(row, args, context)
    return nextWorkflowStepImpl(
      row,
      args,
      note,
      context,
      evidence,
      replayPorts,
      d,
      selfRuling,
      outcome,
      live,
    )
  })
}

async function abandonSelectedWorkflowCursor(
  row: CursorRow,
  reason: string,
  context: WorkflowCursorContext,
  d: Database,
): Promise<string> {
  return abandonWorkflowCursor(row, reason, context, d)
}

/** Abandons a cursor the close service selected before copying its attached text. */
export async function abandonSelectedWorkflowCursorForClose(
  selected: SelectableCursorRow,
  reason: string | undefined,
  context: WorkflowCursorContext,
  d: Database,
  args: Record<string, string>,
): Promise<string> {
  refuseMissingAbandonReason(reason)
  return withLinkedWorkflowTask(selected.project, context, d, async () =>
    abandonSelectedWorkflowCursor(
      await reselectCursor(selected, args, context, d),
      reason,
      context,
      d,
    ),
  )
}

async function awaitWorkflowRulingImpl(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  cursor?: number,
): Promise<{ summary: CursorSummary & { questionId: number }; cursorId: string }> {
  if (!question?.trim()) throw new Error('--question is required')
  const row = await findWorkflowCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  refuseTerminalCursor(row)
  await followTaskCursorClaim({
    project: row.project,
    taskKey: row.workflow_key || null,
    session: row.session_id && row.session_id !== context.session ? null : context.session,
    verb: 'await',
    database: d,
  })
  const resolved = resolveCursorArguments(row, args, d)
  const at = resolved.updatedAt
  const payload: TaskFlowIntentInput<'await-ruling'> = {
    requestId: taskFlowRequestId('await-ruling', [row.record_id, String(row.revision)]),
    stage: {
      id: row.record_id,
      expectedRevision: row.revision,
      values: {
        arguments: resolved.args,
        closedStepNotes: JSON.parse(resolved.closed) as unknown[],
        state: 'awaiting-ruling' as const,
        question: question.trim(),
        sessionId: cursorOwnerAfter('await', row.session_id, context.session),
        updatedAt: at,
      },
    },
  }
  const recordedQuestion = await upsertWorkflowQuestion(
    {
      cursorId: row.record_id,
      projectId: projectByName(row.project, d)?.recordId ?? null,
      workflowKey: row.workflow_key,
      workflowTaskRecordId: row.task_record_id,
      cursorOrdinal: row.ordinal,
      stepSlug: row.step_slug,
      question: question.trim(),
      at,
    },
    d,
  )
  const hosted = await writeHostedTaskFlow(
    'await-ruling',
    payload,
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  writeTransaction(() => {
    const store = taskFlowLocalStore(d)
    store.write('await-ruling', payload, hosted)
  }, d)
  const result = {
    summary: {
      id: row.id,
      n: row.ordinal + 1,
      slug: row.step_slug,
      state: 'awaiting-ruling' as const,
      opened: false,
      questionId: recordedQuestion.number,
    },
    cursorId: row.record_id,
  }
  return result
}

export async function awaitWorkflowRuling(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  notify: (
    ...args: Parameters<typeof notifyWaitingItem>
  ) => void | Promise<void> = notifyWaitingItem,
  cursor?: number,
): Promise<CursorSummary & { questionId: number }> {
  const result = await withLinkedWorkflowTask(project, context, d, () =>
    awaitWorkflowRulingImpl(slug, project, mode, args, question, context, d, cursor),
  )
  await notify('workflow', result.cursorId, d)
  return result.summary
}
