import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { notifyWaitingItem } from '../operator/operator-waiting.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import {
  type TaskFlowIntentInput,
  taskFlowRequestId,
} from '../record/record-task-flow-write-contract.ts'
import { upsertWorkflowQuestion } from '../run/question-mutation.ts'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { decideWorkflowTakeover, workflowTakeoverNotice } from './task-flow-decision.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
  workflowComposeBranchRefusal,
} from './workflow-compose-branch.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import { workflowKeyOf as keyOf, resolveCursorArguments } from './workflow-cursor-arguments.ts'
import { insertWorkflowCursor } from './workflow-cursor-compose.ts'
import { cursorName } from './workflow-cursor-format.ts'
import { abandonWorkflowCursor, closeOpenWorkflowQuestion } from './workflow-cursor-mutation.ts'
import {
  refuseMissingAbandonReason,
  refuseMissingCloseNote,
  refuseTerminalCursor,
  renderWorkflowAdvanceResult,
} from './workflow-cursor-result.ts'
import {
  findWorkflowCursor,
  readThroughWorkflowCursorContext,
  type SelectableCursorRow,
  selectWorkflowCursorForClose,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { taskFlowStore } from './task-flow-store.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'
import {
  type ClosedStep,
  type CursorTrailEntry,
  currentStepActivatedAt,
  isClosedStep,
  reentryBoundFloorInput,
} from './workflow-cursor-trail.ts'
import {
  type CursorState,
  decideConditionalAdvance,
  decideCursorStart,
  decideStepOutcome,
} from './workflow-cursor-transition.ts'
import {
  allowedCloseFloor,
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  decideCloseFloors,
  decideFloorSatisfaction,
  type Floor,
  type FloorDecision,
} from './workflow-floor.ts'
import {
  type FloorEvidencePorts,
  productionFloorPorts,
  type WorkflowEvidenceInput,
} from './workflow-floor-evidence.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'
import { withReplayedFloorEvidenceAsync } from './workflow-floor-evidence-replay.ts'
import { refuseKeylessStepClose } from './workflow-keyless-close.ts'
import { openWorkflowObligations } from './workflow-obligation-floor.ts'
import { selfRulingRefusal } from './workflow-self-ruling.ts'
import {
  recordWorkflowSelfRuling,
  type WorkflowSelfRulingInput,
} from './workflow-self-ruling-mutation.ts'
import { linkResolvedWorkflowTask, withLinkedWorkflowTask } from './workflow-task-linking.ts'
import { deleteWorkflowTextLocally, workflowTextDeletionIds } from './workflow-text.ts'
import { composeWorkflow } from './workflows.ts'

type CursorRow = SelectableCursorRow

/** Re-reads, inside the close transaction, a cursor selected before its text copy. */
function reselectCursor(
  selected: SelectableCursorRow,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  d: Database,
): CursorRow {
  const row = selectWorkflowCursorForClose({}, selected.id, null, d) as CursorRow
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

export type CursorSummary = {
  id: number
  n: number
  slug: string
  state: CursorState
  opened: boolean
  previousSession?: string | null
}

function refuseLocalComposeBranch(
  composition: {
    project: string
    workflow: { slug: string }
    mode: { slug: string }
    arguments: Record<string, string>
  },
  context: WorkflowCursorContext,
  database: Database,
  commitCount: CommitCountPort,
): void {
  const existing = keyOf(composition.arguments)
    ? findWorkflowCursor(
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
) {
  const autonomy = live.resolution
  const composition = composeWorkflow(slug, project, mode, args, d, selection, autonomy)
  if (!composition.mode || composition.needs.arguments) return { ...composition, cursor: null }
  refuseLocalComposeBranch(
    {
      project: composition.project,
      workflow: composition.workflow,
      mode: composition.mode,
      arguments: composition.arguments,
    },
    context,
    d,
    commitCount,
  )
  await readThroughWorkflowCursorContext(project, context, d)
  await linkResolvedWorkflowTask(project, context, d)
  const existing = keyOf(composition.arguments)
    ? findWorkflowCursor(
        composition.project,
        composition.workflow.slug,
        composition.mode!.slug,
        composition.arguments,
        context,
        d,
      )
    : null
  const start = decideCursorStart(existing?.state ?? null)
  let row: CursorRow
  if (existing && start === 'reuse') {
    const resolved = resolveCursorArguments(existing, args, d, true)
    const hosted = await writeHostedTaskFlow(
      'stage-update',
      {
        requestId: taskFlowRequestId('stage-update', [
          existing.record_id,
          String(existing.revision),
        ]),
        stages: [
          {
            id: existing.record_id,
            expectedRevision: existing.revision,
            values: {
              arguments: resolved.args,
              closedStepNotes: JSON.parse(resolved.closed) as unknown[],
              sessionId: context.session ?? existing.session_id,
              updatedAt: resolved.updatedAt,
            },
          },
        ],
      },
      taskFlowWriteTarget(existing.project, d),
      context.taskFlowClient,
    )
    writeTransaction(() => {
      const store = taskFlowStore(d)
      const currentRevision = store.stageRevision(existing.record_id)
      if (currentRevision !== existing.revision)
        throw new Error(`workflow cursor ${existing.id} changed while composing; rerun the command`)
      store.updateReusedStage({
        recordId: existing.record_id,
        argumentsJson: resolved.encoded,
        closedJson: resolved.closed,
        sessionId: context.session ?? null,
        updatedAt: resolved.updatedAt,
        revision: hosted?.revisions[existing.record_id] ?? existing.revision + 1,
      })
    }, d)
    row = taskFlowStore(d).stageByRecordId(existing.record_id) as CursorRow
  } else row = await insertWorkflowCursor(composition, context, d, autonomy, commitCount)
  return {
    ...cursorComposition(row, d, live),
    cursor: {
      id: row.id,
      n: row.ordinal + 1,
      slug: row.step_slug,
      state: row.state,
      opened: start !== 'reuse',
      previousSession: start === 'reuse' ? takenOverFrom(existing, context) : null,
    } satisfies CursorSummary,
  }
}

function applyFloorDecision(
  row: CursorRow,
  floors: Floor[],
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  finishing: boolean,
  d: Database,
  requireRuling = false,
  selfRulingId?: number,
): FloorDecision {
  const args = JSON.parse(row.args) as Record<string, string>
  const validated = gatherValidatedEvidence({
    cursorId: row.record_id,
    identity: {
      project: row.project,
      workflowKey: row.workflow_key,
      workflowTaskRecordId: row.task_record_id,
      branch: args.branch?.trim() || null,
      worktree: args.worktree?.trim() || null,
      session: row.session_id,
      createdAt: row.created_at,
      stepActivatedAt: currentStepActivatedAt(
        row,
        cursorName(row.workflow_slug, row.mode_slug, row.workflow_key),
      ),
    },
    stepOrdinal: row.ordinal + 1,
    stepSlug: row.step_slug,
    floors,
    evidence,
    ports,
    d,
  })
  if (selfRulingId !== undefined)
    validated.ruling = {
      id: selfRulingId,
      answered: true,
      answeredByOperator: false,
      boundToCursor: true,
      boundToStep: true,
      answeredAt: nowIso(),
    }
  return decideFloorSatisfaction({
    floors,
    evidence: validated,
    enforcement: row.enforcement ?? 'note-only',
    finishing,
    openObligations: openWorkflowObligations(row.record_id, d),
    ...reentryBoundFloorInput(requireRuling, row.closed, row.step_slug),
  })
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

function closeFloorsForStep(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  selfRuling: WorkflowSelfRulingInput | undefined,
  outcome: string | undefined,
  d: Database,
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
    selfRulingQuestionNumber = d
      .query<{ n: number }, []>('SELECT COALESCE(MAX(number),0)+1 n FROM question')
      .get()!.n
    floorEvidence = evidence
    selfRulingPlan = {
      cursorId: row.record_id,
      workflowKey: row.workflow_key,
      workflowTaskRecordId: row.task_record_id,
      stepOrdinal: row.ordinal + 1,
      stepSlug: row.step_slug,
      stepTitle: currentStep.title,
      resolvedAutonomy: currentStep.resolvedAutonomy.value,
      floors,
      selfRuling,
    }
  }
  const floor = allowedCloseFloor(
    applyFloorDecision(
      row,
      floors,
      floorEvidence,
      ports,
      advance.ordinal === null,
      d,
      advance.requireRuling,
      selfRulingQuestionNumber,
    ),
    advance.requireRuling,
    currentStep,
  )
  return { closed, advance, floors, floor, selfRulingPlan }
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
): Promise<void> {
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
  const deleteTextIds = advanceTextDeletionIds(row, composition, finishing, d)
  const flow = finishing ? selectClosingTaskFlow(row, d) : null
  const closingFlow = flow?.open_stage_cursor_record_id === row.record_id ? flow : null
  const { parts, obligationInserts, obligationUpdates } = advanceRecordRows(
    row,
    closingFlow,
    obligationPlan,
  )
  const hosted = await writeHostedTaskFlow(
    'advance',
    {
      requestId: taskFlowRequestId('advance', parts),
      stage: {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          arguments: JSON.parse(row.args) as Record<string, string>,
          activeOrdinal: next ? advance.ordinal! : row.ordinal,
          activeSlug: next?.slug ?? row.step_slug,
          state: finishing ? 'done' : 'running',
          closedStepNotes: closed,
          question: null,
          sessionId: context.session ?? row.session_id,
          takenOverFromMachineId: takeoverFromMachineId,
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
    },
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  applyWorkflowAdvanceLocally({
    row,
    closed,
    advance,
    context,
    database: d,
    at,
    takeoverFromMachineId,
    finishing,
    next,
    flow: closingFlow,
    obligationInserts,
    obligationUpdates,
    deleteTextIds,
    selfRulingPlan,
    revisions: hosted?.revisions,
  })
}

function selectClosingTaskFlow(row: CursorRow, database: Database) {
  if (!row.task_flow_record_id) return null
  return taskFlowStore(database).flowState(row.task_flow_record_id)
}

function advanceTextDeletionIds(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  finishing: boolean,
  database: Database,
): string[] {
  if (!finishing && !composition.steps[row.ordinal]!.needs.includes('workflow-text')) return []
  return workflowTextDeletionIds(row.record_id, Boolean(row.task_record_id), database)
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

function applyWorkflowAdvanceLocally(input: {
  row: CursorRow
  closed: CursorTrailEntry[]
  advance: ReturnType<typeof decideConditionalAdvance>
  context: WorkflowCursorContext
  database: Database
  at: string
  takeoverFromMachineId: string | null
  finishing: boolean
  next: ReturnType<typeof composeWorkflow>['steps'][number] | null
  flow: { record_id: string; revision: number } | null
  obligationInserts: NonNullable<TaskFlowIntentInput<'advance'>['obligationInserts']>
  obligationUpdates: NonNullable<TaskFlowIntentInput<'advance'>['obligationUpdates']>
  deleteTextIds: string[]
  selfRulingPlan?: Parameters<typeof recordWorkflowSelfRuling>[0]
  revisions?: Record<string, number>
}): void {
  const {
    row,
    closed,
    advance,
    context,
    database: d,
    at,
    takeoverFromMachineId,
    finishing,
    next,
    flow,
    obligationInserts,
    obligationUpdates,
    deleteTextIds,
    selfRulingPlan,
    revisions,
  } = input
  writeTransaction(() => {
    const currentRevision = taskFlowStore(d).stageRevision(row.record_id)
    if (currentRevision !== row.revision)
      throw new Error(`workflow cursor ${row.id} changed while it advanced; rerun the command`)
    if (row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', at, d)
    if (selfRulingPlan) recordWorkflowSelfRuling(selfRulingPlan, d)
    const store = taskFlowStore(d)
    for (const insert of obligationInserts) store.insertObligation(insert)
    for (const update of obligationUpdates) store.satisfyObligation(update)
    deleteWorkflowTextLocally(deleteTextIds, d)
    const machine = machineId()
    store.advanceStage({
      recordId: row.record_id,
      argumentsJson: row.args,
      ordinal: next ? advance.ordinal! : row.ordinal,
      stepSlug: next?.slug ?? row.step_slug,
      state: finishing ? 'done' : 'running',
      closedJson: JSON.stringify(closed),
      sessionId: context.session ?? null,
      updatedAt: at,
      takenOverFromMachineId: takeoverFromMachineId,
      machineId: machine,
      revision: revisions?.[row.record_id] ?? row.revision + 1,
    })
    if (flow)
      store.clearFlowOpenStage({
        recordId: flow.record_id,
        updatedAt: at,
        machineId: machine,
        revision: revisions?.[flow.record_id] ?? flow.revision + 1,
      })
  }, d)
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
): Promise<string> {
  const slug = row.workflow_slug
  const project = row.project
  const mode = row.mode_slug
  let takeoverNotice: string | null = null
  let takeoverFromMachineId: string | null = null
  if (row.task_flow_record_id && row.last_advanced_machine_id) {
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
    if (decision.action === 'take-over') {
      takeoverFromMachineId = decision.fromMachineId
      takeoverNotice = workflowTakeoverNotice(holderName)
    }
  }
  refuseTerminalCursor(row)
  const resolvedArguments = resolveCursorArguments(row, args, d)
  row.args = resolvedArguments.encoded
  row.closed = resolvedArguments.closed
  refuseKeylessStepClose(row, evidence.task, d, live)
  const workflowKeyBeforeAdoption = row.workflow_key
  await adoptWorkflowTask(
    row,
    evidence.task,
    context.adoptionTaskRecordId ?? context.taskRecordId,
    d,
    context.taskFlowClient,
    context.taskStatusCategory,
  )
  if (row.workflow_key !== workflowKeyBeforeAdoption) {
    row = taskFlowStore(d).stageByRecordId(row.record_id) as CursorRow
  }
  const composition = cursorComposition(row, d, live)
  const step = composition.steps[row.ordinal]!
  refuseMissingCloseNote(note, step.n, step.slug)
  const close = closeFloorsForStep(row, composition, evidence, ports, selfRuling, outcome, d)
  await persistWorkflowAdvance(
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
    takeoverFromMachineId,
    close.selfRulingPlan,
  )
  const rendered = renderWorkflowAdvanceResult({
    row,
    composition,
    closed: close.closed,
    advance: close.advance,
    slug,
    project,
    mode,
    selfRuling,
    d,
    live,
  })
  return takeoverNotice ? `${takeoverNotice}\n${rendered}` : rendered
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
): Promise<string> {
  await linkResolvedWorkflowTask(project, context, d)
  reselectCursor(selected, args, context, d)
  return withReplayedFloorEvidenceAsync(ports, (replayPorts) => {
    const row = taskFlowStore(d).stageByRecordId(selected.record_id) as CursorRow
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
  return withLinkedWorkflowTask(selected.project, context, d, () =>
    abandonSelectedWorkflowCursor(reselectCursor(selected, args, context, d), reason, context, d),
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
  const row = findWorkflowCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  refuseTerminalCursor(row)
  const resolved = resolveCursorArguments(row, args, d)
  const at = resolved.updatedAt
  const hosted = await writeHostedTaskFlow(
    'await-ruling',
    {
      requestId: taskFlowRequestId('await-ruling', [row.record_id, String(row.revision)]),
      stage: {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          arguments: resolved.args,
          closedStepNotes: JSON.parse(resolved.closed) as unknown[],
          state: 'awaiting-ruling',
          question: question.trim(),
          sessionId: context.session ?? row.session_id,
          updatedAt: at,
        },
      },
    },
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  return writeTransaction(() => {
    const store = taskFlowStore(d)
    const currentRevision = store.stageRevision(row.record_id)
    if (currentRevision !== row.revision)
      throw new Error(
        `workflow cursor ${row.id} changed while awaiting a ruling; rerun the command`,
      )
    const machine = machineId()
    store.awaitStageRuling({
      recordId: row.record_id,
      argumentsJson: resolved.encoded,
      closedJson: resolved.closed,
      question: question.trim(),
      sessionId: context.session ?? null,
      updatedAt: at,
      machineId: machine,
      revision: hosted?.revisions[row.record_id] ?? row.revision + 1,
    })
    const recordedQuestion = upsertWorkflowQuestion(
      {
        cursorId: row.record_id,
        workflowKey: row.workflow_key,
        workflowTaskRecordId: row.task_record_id,
        stepOrdinal: row.ordinal + 1,
        stepSlug: row.step_slug,
        question: question.trim(),
        at,
      },
      d,
    )
    return {
      summary: {
        id: row.id,
        n: row.ordinal + 1,
        slug: row.step_slug,
        state: 'awaiting-ruling',
        opened: false,
        questionId: recordedQuestion.number,
      },
      cursorId: row.record_id,
    }
  }, d)
}

export async function awaitWorkflowRuling(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  notify: typeof notifyWaitingItem = notifyWaitingItem,
  cursor?: number,
): Promise<CursorSummary & { questionId: number }> {
  const result = await withLinkedWorkflowTask(project, context, d, () =>
    awaitWorkflowRulingImpl(slug, project, mode, args, question, context, d, cursor),
  )
  notify('workflow', result.cursorId, d)
  return result.summary
}
