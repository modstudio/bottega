import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { notifyWaitingItem } from '../operator/operator-waiting.ts'
import { closeQuestions } from '../run/question-close.ts'
import {
  answerWorkflowQuestion,
  authorizeWorkflowQuestionMutation,
  upsertWorkflowQuestion,
} from '../run/question-mutation.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { resolvedRulingPersonName } from '../run/ruling-attribution.ts'
import type { AutonomyResolution, LiveCursorAutonomy } from './autonomy.ts'
import {
  type CommitCountPort,
  readCommitsPastLanding,
  workflowComposeBranchRefusal,
} from './workflow-compose-branch.ts'
import { adoptWorkflowTask, vacateRetiredWorkflowKeySlot } from './workflow-cursor-adoption.ts'
import { applyCursorArguments, workflowKeyOf as keyOf } from './workflow-cursor-arguments.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { cursorName, formatCursorOpened, formatCursorResumed } from './workflow-cursor-format.ts'
import {
  refuseInvalidServe,
  refuseTerminalCursor,
  renderWorkflowAdvanceResult,
} from './workflow-cursor-result.ts'
import {
  type SelectableCursorRow,
  selectUntouchedKeylessWorkflowCursor,
  selectWorkflowCursor,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { refuseUnlinkedCursorLabelCollision } from './workflow-cursor-task-reference.ts'
import {
  type ClosedStep,
  type CursorTrailEntry,
  currentStepActivatedAt,
  isClosedStep,
  reentryBoundFloorInput,
} from './workflow-cursor-trail.ts'
import {
  type CursorState,
  cursorValue,
  decideConditionalAdvance,
  decideCursorCompositionInput,
  decideCursorStart,
  decideCursorTransition,
  decideStepOutcome,
  stepPass,
} from './workflow-cursor-transition.ts'
import {
  allowedCloseFloor,
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  decideCloseFloors,
  decideFloorSatisfaction,
  type EnforcementMode,
  type Floor,
  type FloorDecision,
} from './workflow-floor.ts'
import {
  type FloorEvidencePorts,
  openWorkflowObligations,
  productionFloorPorts,
  type WorkflowEvidenceInput,
} from './workflow-floor-evidence.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'
import { withReplayedFloorEvidence } from './workflow-floor-evidence-replay.ts'
import { refuseKeylessStepClose } from './workflow-keyless-close.ts'
import { decideWorkflowRuleAnswer, pinnedWorkflowRuleStep } from './workflow-rule-answer.ts'
import {
  bindCloseSelfRuling,
  type WorkflowSelfRulingInput,
} from './workflow-self-ruling-mutation.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { linkResolvedWorkflowTask, withLinkedWorkflowTask } from './workflow-task-linking.ts'
import { deleteWorkflowText, withWorkflowTextFacts } from './workflow-text.ts'
import { composeWorkflow, getWorkflowStep } from './workflows.ts'

type CursorRow = SelectableCursorRow & {
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
  closed: string
  question: string | null
  total_steps: number
  created_at: string
  updated_at: string
  enforcement: EnforcementMode
}

function closeOpenWorkflowQuestion(
  cursorId: string,
  reason: 'advanced-without-ruling' | 'abandoned',
  at: string,
  d: Database,
): void {
  const questions = d
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM question
       WHERE workflow_cursor_record_id=? AND ${questionOpenSql('question')}`,
    )
    .all(cursorId)
  const ids = questions.map((question) => question.record_id)
  closeQuestions(d, ids, reason, sessionId(), at)
}

function findCursor(
  project: string,
  workflow: string,
  mode: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  d: Database,
  cursor?: number,
): CursorRow | null {
  const key = keyOf(args)
  return selectWorkflowCursor(
    { project, workflow, mode, ...(key ? { key } : {}) },
    cursor,
    context.session,
    d,
    context.taskRecordId,
  ) as CursorRow | null
}

const takenOverFrom = (row: CursorRow | null, context: WorkflowCursorContext): string | null =>
  row?.session_id && context.session && row.session_id !== context.session ? row.session_id : null

/**
 * Create, or resume, the cursor a composition opens.
 *
 * Every door that opens a cursor comes through here, so the empty-branch refusal is taken once
 * rather than at each caller: a workflow that lands a built branch is not opened for a branch that
 * carries nothing to land.
 */
function insertCursor(
  composition: ReturnType<typeof composeWorkflow>,
  context: WorkflowCursorContext,
  d: Database,
  autonomy?: AutonomyResolution,
  commitCount: CommitCountPort = readCommitsPastLanding,
): CursorRow {
  const refusal = workflowComposeBranchRefusal({
    workflow: composition.workflow.slug,
    project: composition.project,
    args: composition.arguments,
    d,
    commitCount,
  })
  if (refusal) throw new Error(refusal)
  const cursorRecordId = newRecordId()
  const key = keyOf(composition.arguments)
  const instance = key ? '' : randomUUID()
  const at = nowIso()
  if (key)
    refuseUnlinkedCursorLabelCollision(d, {
      project: composition.project,
      workflow: composition.workflow.slug,
      mode: composition.mode!.slug,
      key,
      taskRecordId: context.taskRecordId,
    })
  const existing = key
    ? findCursor(
        composition.project,
        composition.workflow.slug,
        composition.mode!.slug,
        composition.arguments,
        context,
        d,
      )
    : null
  if (decideCursorStart(existing?.state ?? null) === 'retire') {
    vacateRetiredWorkflowKeySlot(
      composition.project,
      composition.workflow.slug,
      composition.mode!.slug,
      key,
      d,
    )
  }
  const autonomySnapshot = autonomy
    ? {
        ...autonomy,
        ...(autonomy.session
          ? {
              session: Object.fromEntries(
                Object.entries(autonomy.session).filter(([key]) => key !== 'shipTo'),
              ),
            }
          : {}),
      }
    : undefined
  const stored = d
    .query<{ record_id: string }, (string | number | null)[]>(
      `INSERT INTO workflow_cursor
      (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,instance_id,session_id,
       workflow_version_record_id,catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,(SELECT record_id FROM project WHERE name=?),?,?,?,?,?,?,?,?,?,?,0,?,'running','[]',NULL,?,?,?,'floors')
     ON CONFLICT(project_record_id,workflow_slug,mode_slug,workflow_key,instance_id) DO UPDATE SET
       session_id=COALESCE(excluded.session_id,workflow_cursor.session_id),
       updated_at=excluded.updated_at
     RETURNING record_id`,
    )
    .get(
      cursorRecordId,
      composition.project,
      composition.project,
      composition.workflow.slug,
      composition.mode!.slug,
      key,
      context.taskRecordId ?? null,
      instance,
      context.session ?? null,
      composition.workflow.record_id,
      composition.catalogue.record_id,
      JSON.stringify(composition.arguments),
      JSON.stringify(
        autonomySnapshot ?? {
          steps: Object.fromEntries(
            composition.steps.map((step) => [step.slug, step.resolvedAutonomy]),
          ),
          rulings: composition.rulings,
        },
      ),
      composition.steps[0]!.slug,
      composition.steps.length,
      at,
      at,
    )
  return d
    .query('SELECT number id,* FROM workflow_cursor WHERE record_id=?')
    .get(stored!.record_id) as CursorRow
}

export type CursorSummary = {
  id: number
  n: number
  slug: string
  state: CursorState
  opened: boolean
  previousSession?: string | null
}

export function composeWorkflowWithCursor(
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
  return writeTransaction(() => {
    linkResolvedWorkflowTask(project, args, context, d)
    const existing = keyOf(composition.arguments)
      ? findCursor(
          composition.project,
          composition.workflow.slug,
          composition.mode!.slug,
          composition.arguments,
          context,
          d,
        )
      : null
    const start = decideCursorStart(existing?.state ?? null)
    if (existing && start === 'reuse') applyCursorArguments(existing, args, d, true)
    const row = insertCursor(composition, context, d, autonomy, commitCount)
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
  }, d)
}

export function cursorComposition(
  row: SelectableCursorRow,
  d: Database,
  live?: LiveCursorAutonomy,
) {
  return composeWorkflow(
    row.workflow_slug,
    row.project,
    row.mode_slug,
    JSON.parse(row.args) as Record<string, string>,
    d,
    {
      version: row.workflow_version,
      versionRecordId: row.workflow_version_record_id,
      catalogueVersion: row.catalogue_version,
      catalogueVersionRecordId: row.catalogue_version_record_id,
    },
    cursorAutonomy(row, live),
  )
}

function prepareStepServe(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  d: Database,
  autonomy: AutonomyResolution | undefined,
  cursor: number | undefined,
  live?: LiveCursorAutonomy,
  commitCount: CommitCountPort = readCommitsPastLanding,
) {
  const handled =
    cursor === undefined ? null : findCursor(project, slug, mode, args, context, d, cursor)
  const preliminary =
    handled && decideCursorStart(handled.state) === 'reuse'
      ? cursorComposition(handled, d, live)
      : composeWorkflow(slug, project, mode, args, d, { mode }, autonomy)
  const preliminaryStepSlug = resolveWorkflowStepReference(stepSlug, [
    { mode, steps: preliminary.steps.map((step) => step.slug) },
  ])
  const openingKeyless =
    cursor === undefined && !keyOf(args) && preliminary.steps[0]?.slug === preliminaryStepSlug
  const candidate = openingKeyless
    ? (selectUntouchedKeylessWorkflowCursor(
        { project, workflow: slug, mode },
        context.session,
        d,
      ) as CursorRow | null)
    : (handled ?? findCursor(project, slug, mode, args, context, d, cursor))
  let row = handled ?? candidate
  const opensCursor = row === null
  const startDecision = decideCursorStart(row?.state ?? null)
  if (row && startDecision === 'reuse') applyCursorArguments(row, args, d)
  const input = decideCursorCompositionInput(row, args, mode)
  const composition = composeWorkflow(
    slug,
    project,
    mode,
    input.effectiveArgs,
    d,
    input.selection,
    row && input.startDecision === 'reuse' ? cursorAutonomy(row, live) : autonomy,
  )
  const resolvedStepSlug = resolveWorkflowStepReference(stepSlug, [
    { mode, steps: composition.steps.map((step) => step.slug) },
  ])
  const index = composition.steps.findIndex((step) => step.slug === resolvedStepSlug)
  if (index < 0) throw new Error(`workflow "${slug}" has no step "${resolvedStepSlug}"`)
  const requested = composition.steps[index]!
  if (index === 0 && startDecision === 'retire')
    row = insertCursor(composition, context, d, autonomy, commitCount)
  return { row, opensCursor, composition, requested, index, input }
}

function getWorkflowStepWithCursorImpl(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  autonomy?: AutonomyResolution,
  cursor?: number,
  live?: LiveCursorAutonomy,
  commitCount: CommitCountPort = readCommitsPastLanding,
) {
  const prepared = prepareStepServe(
    slug,
    project,
    stepSlug,
    args,
    mode,
    context,
    d,
    autonomy,
    cursor,
    live,
    commitCount,
  )
  let { row } = prepared
  const { opensCursor, composition, requested, index, input } = prepared
  const decision = decideCursorTransition(
    row ? cursorValue(row.ordinal, row.step_slug, row.state) : null,
    { kind: 'serve', ordinal: index, slug: requested.slug },
  )
  refuseInvalidServe(decision, row, composition, slug, mode, args)
  if (decision.action !== 'serve') throw new Error('invalid serve transition')
  if (!row) row = insertCursor(composition, context, d, autonomy, commitCount)
  if (decision.move || decision.resume) {
    if (row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', nowIso(), d)
    d.query(
      `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
    ).run(decision.ordinal, decision.slug, context.session ?? null, nowIso(), row.record_id)
  }
  const served = withWorkflowTextFacts(
    getWorkflowStep(
      slug,
      project,
      decision.slug,
      input.effectiveArgs,
      d,
      input.selection,
      cursorAutonomy(row, live),
    ),
    row.record_id,
    d,
  )
  const openNotice = opensCursor
    ? formatCursorOpened({
        cursor: row.id,
        workflow: slug,
        mode,
        key: row.workflow_key,
        step: 1,
        stepSlug: row.step_slug,
      })
    : !cursor && row.workflow_key
      ? formatCursorResumed({
          cursor: row.id,
          key: row.workflow_key,
          step: row.ordinal + 1,
          stepSlug: row.step_slug,
        })
      : undefined
  const redirectNotice =
    decision.slug !== requested.slug
      ? `Requested step ${index + 1} ${requested.slug}; serving active step ${decision.ordinal + 1} ${decision.slug}.`
      : undefined
  const flow = (JSON.parse(row.closed) as CursorTrailEntry[]).filter(isClosedStep)
  return {
    ...served,
    cursor: row.id,
    flow,
    pass: stepPass(flow, composition.steps, decision.ordinal),
    notice: [openNotice, redirectNotice].filter(Boolean).join('\n'),
  }
}

export function getWorkflowStepWithCursor(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  live: LiveCursorAutonomy,
  cursor?: number,
  commitCount: CommitCountPort = readCommitsPastLanding,
) {
  const autonomy = live.resolution
  return withLinkedWorkflowTask(project, args, context, d, () =>
    getWorkflowStepWithCursorImpl(
      slug,
      project,
      stepSlug,
      args,
      mode,
      context,
      d,
      autonomy,
      cursor,
      live,
      commitCount,
    ),
  )
}

function applyFloorDecision(
  row: CursorRow,
  floors: Floor[],
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  finishing: boolean,
  d: Database,
  requireRuling = false,
): FloorDecision {
  const args = JSON.parse(row.args) as Record<string, string>
  return decideFloorSatisfaction({
    floors,
    evidence: gatherValidatedEvidence({
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
    }),
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
  d: Database,
): Pick<ClosedStep, 'evidence' | 'deferred' | 'satisfied'> {
  let deferred: ClosedStep['deferred']
  if (decision.defer) {
    const floor = floors.find((item) => item.kind === decision.defer?.floor)
    const inserted = d
      .query<{ id: string }, (string | number | null)[]>(
        `INSERT INTO workflow_obligation
          (record_id,cursor_record_id,step_ordinal,step_slug,floor,require_pull_request,operator_ruling,
           expected_exit_code,expected_status,floor_deferrable,reason,session_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id id`,
      )
      .get(
        newRecordId(),
        row.record_id,
        row.ordinal + 1,
        row.step_slug,
        decision.defer.floor,
        floor?.requirePullRequest ? 1 : 0,
        floor?.operatorRuling ? 1 : 0,
        floor?.expectedExitCode ?? DEFAULT_EXPECTED_EXIT_CODE,
        floor?.expectedStatus ?? DEFAULT_EXPECTED_STATUS,
        floor?.deferrable ? 1 : 0,
        decision.defer.reason,
        row.session_id,
        at,
      )
    if (!inserted) throw new Error('obligation was not recorded')
    deferred = { id: inserted.id, floor: decision.defer.floor, reason: decision.defer.reason }
  }
  if (decision.satisfyId) {
    d.query(
      `UPDATE workflow_obligation
          SET satisfied_at=?,satisfied_step_ordinal=?,satisfied_step_slug=?,satisfied_evidence=?
        WHERE record_id=? AND cursor_record_id=? AND satisfied_at IS NULL`,
    ).run(
      at,
      row.ordinal + 1,
      row.step_slug,
      JSON.stringify(decision.refs),
      decision.satisfyId,
      row.record_id,
    )
  }
  return {
    ...(decision.refs.length ? { evidence: decision.refs } : {}),
    ...(deferred ? { deferred } : {}),
    ...(decision.satisfyId ? { satisfied: decision.satisfyId } : {}),
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
  d: Database,
): void {
  const review = composition.steps[row.ordinal]?.resolvedAutonomy.value === 'review'
  closed.push({
    n: row.ordinal + 1,
    slug: row.step_slug,
    note,
    at,
    ...(outcome ? { outcome } : {}),
    ...(reentered ? { reentered } : {}),
    ...(review ? { review: true as const } : {}),
    ...persistFloorClose(row, floor, floors, at, d),
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
  const floor = allowedCloseFloor(
    applyFloorDecision(
      row,
      floors,
      bindCloseSelfRuling(
        {
          cursorId: row.record_id,
          workflowKey: row.workflow_key,
          workflowTaskRecordId: row.task_record_id,
          stepOrdinal: row.ordinal + 1,
          stepSlug: row.step_slug,
          stepTitle: currentStep.title,
          resolvedAutonomy: currentStep.resolvedAutonomy.value,
          floors,
          selfRuling,
          evidence,
        },
        d,
      ),
      ports,
      advance.ordinal === null,
      d,
      advance.requireRuling,
    ),
    advance.requireRuling,
    currentStep,
  )
  return { closed, advance, floors, floor }
}

function persistWorkflowAdvance(
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
): void {
  const at = nowIso()
  if (row.state === 'awaiting-ruling')
    closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', at, d)
  appendWorkflowClose(
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
    d,
  )
  if (advance.ordinal === null || composition.steps[row.ordinal]!.needs.includes('workflow-text'))
    deleteWorkflowText(row.record_id, Boolean(row.task_record_id), d)
  if (advance.ordinal === null) {
    d.query(
      `UPDATE workflow_cursor SET state='done',closed=?,question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
    ).run(JSON.stringify(closed), context.session ?? null, at, row.record_id)
    return
  }
  const next = composition.steps[advance.ordinal]!
  d.query(
    `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
  ).run(
    advance.ordinal,
    next.slug,
    JSON.stringify(closed),
    context.session ?? null,
    at,
    row.record_id,
  )
}

function nextWorkflowStepImpl(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  note: string | undefined,
  context: WorkflowCursorContext,
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  d: Database = writableDb(),
  cursor?: number,
  selfRuling?: WorkflowSelfRulingInput,
  outcome?: string,
  live?: LiveCursorAutonomy,
): string {
  const row = findCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  slug = row.workflow_slug
  project = row.project
  mode = row.mode_slug
  refuseTerminalCursor(row)
  applyCursorArguments(row, args, d)
  refuseKeylessStepClose(row, evidence.task, d, live)
  adoptWorkflowTask(row, evidence.task, context.adoptionTaskRecordId ?? context.taskRecordId, d)
  const composition = cursorComposition(row, d, live)
  if (!note?.trim()) {
    const step = composition.steps[row.ordinal]!
    throw new Error(
      `--note is required: one line saying how step ${step.n} ${step.slug}'s floor was met`,
    )
  }
  const close = closeFloorsForStep(row, composition, evidence, ports, selfRuling, outcome, d)
  persistWorkflowAdvance(
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
  )
  return renderWorkflowAdvanceResult({
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
}

export function nextWorkflowStep(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  note: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  evidence: WorkflowEvidenceInput = {},
  ports: FloorEvidencePorts = productionFloorPorts(),
  cursor?: number,
  selfRuling?: WorkflowSelfRulingInput,
  outcome?: string,
  live?: LiveCursorAutonomy,
): string {
  return withReplayedFloorEvidence(ports, (replayPorts) =>
    withLinkedWorkflowTask(project, args, context, d, () =>
      nextWorkflowStepImpl(
        slug,
        project,
        mode,
        args,
        note,
        context,
        evidence,
        replayPorts,
        d,
        cursor,
        selfRuling,
        outcome,
        live,
      ),
    ),
  )
}

function abandonWorkflowCursorImpl(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  reason: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  cursor?: number,
): string {
  if (!reason?.trim()) throw new Error('--reason is required')
  const row = findCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  return abandonSelectedWorkflowCursor(row, reason, context, d)
}

function abandonSelectedWorkflowCursor(
  row: CursorRow,
  reason: string,
  context: WorkflowCursorContext,
  d: Database,
): string {
  const slug = row.workflow_slug
  const mode = row.mode_slug
  refuseTerminalCursor(row)
  const at = nowIso()
  if (row.state === 'awaiting-ruling') closeOpenWorkflowQuestion(row.record_id, 'abandoned', at, d)
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  closed.push({
    n: row.ordinal + 1,
    slug: row.step_slug,
    note: `abandoned: ${reason.trim()}`,
    at,
  })
  d.query(
    `UPDATE workflow_obligation
        SET abandoned_at=?, abandoned_reason=?
      WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL`,
  ).run(at, reason.trim(), row.record_id)
  deleteWorkflowText(row.record_id, Boolean(row.task_record_id), d)
  d.query(
    `UPDATE workflow_cursor SET state='abandoned',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
  ).run(JSON.stringify(closed), context.session ?? null, at, row.record_id)
  return `${cursorName(slug, mode, row.workflow_key, true)} was abandoned at step ${row.ordinal + 1} ${row.step_slug}.`
}

export function abandonWorkflowCursor(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  reason: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  cursor?: number,
): string {
  return withLinkedWorkflowTask(project, args, context, d, () =>
    abandonWorkflowCursorImpl(slug, project, mode, args, reason, context, d, cursor),
  )
}

export function abandonWorkflowCursorByHandle(
  cursor: number,
  reason: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): string {
  if (!reason?.trim()) throw new Error('--reason is required')
  return writeTransaction(() => {
    const row = selectWorkflowCursor({}, cursor, context.session, d) as CursorRow
    return abandonSelectedWorkflowCursor(row, reason, context, d)
  }, d)
}

function awaitWorkflowRulingImpl(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  cursor?: number,
): { summary: CursorSummary & { questionId: number }; cursorId: string } {
  if (!question?.trim()) throw new Error('--question is required')
  const row = findCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  refuseTerminalCursor(row)
  applyCursorArguments(row, args, d)
  const at = nowIso()
  d.query(
    `UPDATE workflow_cursor SET state='awaiting-ruling',question=?,
     session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
  ).run(question.trim(), context.session ?? null, at, row.record_id)
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
}

export function ruleWorkflow(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  ruling: string | undefined,
  fromOperator: boolean,
  channel: 'cli' | 'mcp',
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  cursor?: number,
): { summary: string; questionId: number } {
  if (!ruling?.trim()) throw new Error('--ruling is required')
  return writeTransaction(() => {
    linkResolvedWorkflowTask(project, args, context, d)
    const row = findCursor(project, slug, mode, args, context, d, cursor)
    if (!row)
      throw new Error(
        `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
      )
    if (row.state !== 'awaiting-ruling')
      throw new Error(`${cursorName(slug, mode, row.workflow_key)} is not awaiting a ruling`)
    const step = pinnedWorkflowRuleStep(row, cursorName(slug, mode, row.workflow_key), d)
    const refusal = decideWorkflowRuleAnswer({
      fromOperator,
      operatorRuling: Boolean(step.operatorRuling),
    })
    if (refusal) throw new Error(refusal)
    const actor = sessionId()
    const adoptionReason = authorizeWorkflowQuestionMutation({
      owner: row.session_id,
      actor,
      fromOperator,
      subject: cursorName(slug, mode, row.workflow_key),
      action: 'rule',
      chainLastActivityAt: Date.parse(row.updated_at),
      database: d,
    })
    const at = nowIso()
    const question = d
      .query<{ record_id: string; number: number }, [string]>(
        `SELECT record_id,number FROM question
         WHERE workflow_cursor_record_id=? AND ${questionOpenSql('question')}`,
      )
      .get(row.record_id)
    if (!question)
      throw new Error(`${cursorName(slug, mode, row.workflow_key)} has no open question to rule on`)
    answerWorkflowQuestion(
      {
        questionId: question.record_id,
        cursorId: row.record_id,
        ruling: ruling.trim(),
        at,
        actor,
        fromOperator,
        personName: resolvedRulingPersonName(fromOperator),
        channel,
        adoptionReason,
      },
      d,
    )
    d.query(
      `UPDATE workflow_cursor SET state='running',question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
    ).run(adoptionReason ? null : (context.session ?? null), at, row.record_id)
    return {
      summary: `${cursorName(slug, mode, row.workflow_key, true)} is running at step ${row.ordinal + 1} ${row.step_slug}.`,
      questionId: question.number,
    }
  }, d)
}

export function awaitWorkflowRuling(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  notify: typeof notifyWaitingItem = notifyWaitingItem,
  cursor?: number,
): CursorSummary & { questionId: number } {
  const result = withLinkedWorkflowTask(project, args, context, d, () =>
    awaitWorkflowRulingImpl(slug, project, mode, args, question, context, d, cursor),
  )
  notify('workflow', result.cursorId, d)
  return result.summary
}
