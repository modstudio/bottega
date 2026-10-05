import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { notifyWaitingItem } from '../operator/operator-waiting.ts'
import { projectAt } from '../project/projects.ts'
import { closeQuestions } from '../run/question-close.ts'
import {
  auditQuestionMutation,
  authorizeWorkflowQuestionMutation,
} from '../run/question-mutation.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { rulingActor } from '../run/question-vocabulary.ts'
import type { AutonomyResolution } from './autonomy.ts'
import { adoptWorkflowTask } from './workflow-cursor-adoption.ts'
import { applyCursorArguments, workflowKeyOf as keyOf } from './workflow-cursor-arguments.ts'
import {
  type SelectableCursorRow,
  selectUntouchedKeylessWorkflowCursor,
  selectWorkflowCursor,
} from './workflow-cursor-selection.ts'
import {
  type ClosedStep,
  type CursorTrailEntry,
  currentStepActivatedAt,
  isClosedStep,
} from './workflow-cursor-trail.ts'
import {
  type CursorState,
  type CursorValue,
  decideCursorStart,
  decideCursorTransition,
} from './workflow-cursor-transition.ts'
import {
  catalogueFloors,
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  decideFloorSatisfaction,
  type EnforcementMode,
  type FloorDecision,
  type OpenObligation,
} from './workflow-floor.ts'
import {
  type FloorEvidencePorts,
  gatherValidatedEvidence,
  productionFloorPorts,
  type WorkflowEvidenceInput,
} from './workflow-floor-evidence.ts'
import { renderWorkflowStep } from './workflow-render.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { composeWorkflow, getWorkflowStep } from './workflows.ts'

export type WorkflowCursorContext = {
  session?: string | null
  /** Used only for a keyless workflow when the harness supplies no session id. */
  instance?: string
}

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

const MCP_INSTANCE = randomUUID()
export const mcpWorkflowCursorContext = (): WorkflowCursorContext => ({
  session: sessionId(),
  instance: MCP_INSTANCE,
})
export const cliWorkflowCursorContext = (): WorkflowCursorContext => ({ session: sessionId() })

const instanceOf = (key: string): string => (key ? '' : randomUUID())
const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
const cursorName = (slug: string, mode: string, key: string, capitalized = false) =>
  `${capitalized ? 'Workflow' : 'workflow'} ${slug}${key ? ` for ${key}` : ` (${mode})`}`

const cursorValue = (row: CursorRow): CursorValue => ({
  ordinal: row.ordinal,
  stepSlug: row.step_slug,
  state: row.state,
})

function closeOpenWorkflowQuestion(
  cursorId: number,
  reason: 'advanced-without-ruling' | 'abandoned',
  at: string,
  d: Database,
): void {
  const questions = d
    .query<{ id: number }, [number]>(
      `SELECT id FROM question
       WHERE workflow_cursor_id=? AND ${questionOpenSql('question')}`,
    )
    .all(cursorId)
  closeQuestions(
    d,
    questions.map((question) => question.id),
    reason,
    sessionId(),
    at,
  )
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
  ) as CursorRow | null
}

/** The session that drove this cursor before the current one took it over, or null. */
const takenOverFrom = (row: CursorRow | null, context: WorkflowCursorContext): string | null =>
  row?.session_id && context.session && row.session_id !== context.session ? row.session_id : null

function insertCursor(
  composition: ReturnType<typeof composeWorkflow>,
  context: WorkflowCursorContext,
  d: Database,
  autonomy?: AutonomyResolution,
): CursorRow {
  const key = keyOf(composition.arguments)
  const instance = instanceOf(key)
  const at = nowIso()
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
    d.query(`UPDATE workflow_cursor SET instance_id=instance_id || '#' || id WHERE id=?`).run(
      existing!.id,
    )
  }
  const autonomySnapshot = autonomy
    ? {
        ...autonomy,
        ...(autonomy.session
          ? {
              session: Object.fromEntries(
                Object.entries(autonomy.session).filter(([key]) => key !== 'release'),
              ),
            }
          : {}),
      }
    : undefined
  d.query(
    `INSERT INTO workflow_cursor
      (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version,catalogue_version,args,autonomy,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at,enforcement)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,'running','[]',NULL,?,?,?,'floors')
     ON CONFLICT(project,workflow_slug,mode_slug,workflow_key,instance_id) DO UPDATE SET
       session_id=COALESCE(excluded.session_id,workflow_cursor.session_id),
       updated_at=excluded.updated_at`,
  ).run(
    composition.project,
    composition.workflow.slug,
    composition.mode!.slug,
    key,
    instance,
    context.session ?? null,
    composition.workflow.version,
    composition.catalogue.version,
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
  return key
    ? findCursor(
        composition.project,
        composition.workflow.slug,
        composition.mode!.slug,
        composition.arguments,
        context,
        d,
      )!
    : (d.query('SELECT * FROM workflow_cursor WHERE id=last_insert_rowid()').get() as CursorRow)
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
  autonomy?: AutonomyResolution,
) {
  const composition = composeWorkflow(slug, project, mode, args, d, selection, autonomy)
  if (!composition.mode || composition.needs.arguments) return { ...composition, cursor: null }
  return writeTransaction(() => {
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
    const previousSession =
      decideCursorStart(existing?.state ?? null) === 'reuse'
        ? takenOverFrom(existing, context)
        : null
    if (existing && decideCursorStart(existing.state) === 'reuse')
      applyCursorArguments(existing, args, d)
    const row = insertCursor(composition, context, d, autonomy)
    return {
      ...cursorComposition(row, d),
      cursor: {
        id: row.id,
        n: row.ordinal + 1,
        slug: row.step_slug,
        state: row.state,
        opened: !existing || decideCursorStart(existing.state) === 'retire',
        previousSession,
      } satisfies CursorSummary,
    }
  }, d)
}

function cursorComposition(row: CursorRow, d: Database) {
  return composeWorkflow(
    row.workflow_slug,
    row.project,
    row.mode_slug,
    JSON.parse(row.args) as Record<string, string>,
    d,
    { version: row.workflow_version, catalogueVersion: row.catalogue_version },
    cursorAutonomy(row),
  )
}

function cursorAutonomy(row: CursorRow): AutonomyResolution | undefined {
  return row.autonomy ? (JSON.parse(row.autonomy) as AutonomyResolution) : undefined
}

function remedy(row: CursorRow, composition: ReturnType<typeof composeWorkflow>): string {
  const active = composition.steps[row.ordinal]!
  const args = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return (
    `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key)} is at step ${active.n} ${active.slug}; ` +
    `fetch that step, or close it with: orch workflow next ${row.workflow_slug} --project ${row.project} ` +
    `--mode ${row.mode_slug}${args} --note "<how its floor was met>"`
  )
}

function cursorCompositionInput(row: CursorRow | null, args: Record<string, string>, mode: string) {
  const startDecision = decideCursorStart(row?.state ?? null)
  if (!row || startDecision === 'retire') {
    return { startDecision, effectiveArgs: args, selection: { mode } }
  }
  return {
    startDecision,
    effectiveArgs: JSON.parse(row.args) as Record<string, string>,
    selection: {
      mode,
      version: row.workflow_version,
      catalogueVersion: row.catalogue_version,
    },
  }
}

function refuseInvalidServe(
  decision: ReturnType<typeof decideCursorTransition>,
  row: CursorRow | null,
  composition: ReturnType<typeof composeWorkflow>,
  slug: string,
  mode: string,
  args: Record<string, string>,
): void {
  if (decision.action !== 'refuse') return
  if (decision.reason === 'compose-first') {
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  }
  if (decision.reason === 'state') {
    throw new Error(
      `${cursorName(slug, mode, row!.workflow_key)} is ${row!.state}; compose it again to start a new run`,
    )
  }
  throw new Error(remedy(row!, composition))
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
) {
  const handled =
    cursor === undefined ? null : findCursor(project, slug, mode, args, context, d, cursor)
  const preliminary = handled
    ? cursorComposition(handled, d)
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
  const input = cursorCompositionInput(row, args, mode)
  const composition = composeWorkflow(
    slug,
    project,
    mode,
    input.effectiveArgs,
    d,
    input.selection,
    row ? cursorAutonomy(row) : autonomy,
  )
  const resolvedStepSlug = resolveWorkflowStepReference(stepSlug, [
    { mode, steps: composition.steps.map((step) => step.slug) },
  ])
  const index = composition.steps.findIndex((step) => step.slug === resolvedStepSlug)
  if (index < 0) throw new Error(`workflow "${slug}" has no step "${resolvedStepSlug}"`)
  const requested = composition.steps[index]!
  if (index === 0 && startDecision === 'retire')
    row = insertCursor(composition, context, d, autonomy)
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
  )
  let { row } = prepared
  const { opensCursor, composition, requested, index, input } = prepared
  const decision = decideCursorTransition(row ? cursorValue(row) : null, {
    kind: 'serve',
    ordinal: index,
    slug: requested.slug,
  })
  refuseInvalidServe(decision, row, composition, slug, mode, args)
  if (decision.action !== 'serve') throw new Error('invalid serve transition')
  if (!row) row = insertCursor(composition, context, d, autonomy)
  if (decision.move || decision.resume) {
    if (row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.id, 'advanced-without-ruling', nowIso(), d)
    d.query(
      `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(decision.ordinal, decision.slug, context.session ?? null, nowIso(), row.id)
  }
  const served = getWorkflowStep(
    slug,
    project,
    decision.slug,
    input.effectiveArgs,
    d,
    input.selection,
    cursorAutonomy(row),
  )
  const key = row.workflow_key ? `for ${row.workflow_key}` : 'unassigned'
  const openNotice = opensCursor
    ? `Cursor ${row.id} was opened for workflow ${slug} and mode ${mode}, ${key}, at step 1 ${row.step_slug}.`
    : !cursor && row.workflow_key
      ? `Cursor ${row.id} is already open at step ${row.ordinal + 1} ${row.step_slug} for ${row.workflow_key}.`
      : undefined
  const redirectNotice =
    decision.slug !== requested.slug
      ? `Requested step ${index + 1} ${requested.slug}; serving active step ${decision.ordinal + 1} ${decision.slug}.`
      : undefined
  return {
    ...served,
    cursor: row.id,
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
  autonomy?: AutonomyResolution,
  cursor?: number,
) {
  return writeTransaction(
    () =>
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
      ),
    d,
  )
}

function openObligations(cursorId: number, d: Database): OpenObligation[] {
  return d
    .query<OpenObligation, [number]>(
      `SELECT id, step_ordinal AS stepOrdinal, step_slug AS stepSlug, floor
         FROM workflow_obligation
        WHERE cursor_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL ORDER BY id`,
    )
    .all(cursorId)
}

function applyFloorDecision(
  row: CursorRow,
  composition: ReturnType<typeof composeWorkflow>,
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  finishing: boolean,
  d: Database,
): FloorDecision {
  const step = composition.steps[row.ordinal]!
  const args = JSON.parse(row.args) as Record<string, string>
  const gathered = gatherValidatedEvidence({
    cursorId: row.id,
    identity: {
      project: row.project,
      workflowKey: row.workflow_key,
      branch: args.branch?.trim() || null,
      worktree: args.worktree?.trim() || null,
      session: row.session_id,
      stepActivatedAt: currentStepActivatedAt(
        row,
        cursorName(row.workflow_slug, row.mode_slug, row.workflow_key),
      ),
    },
    stepOrdinal: row.ordinal + 1,
    stepSlug: row.step_slug,
    evidence,
    ports,
    d,
  })
  return decideFloorSatisfaction({
    floors: catalogueFloors(
      step.floor,
      step.deferrable ?? [],
      step.expectedStatus,
      Boolean(step.requirePullRequest),
    ),
    evidence: gathered,
    enforcement: row.enforcement ?? 'note-only',
    finishing,
    openObligations: openObligations(row.id, d),
  })
}

function persistFloorClose(
  row: CursorRow,
  decision: Extract<FloorDecision, { action: 'allow' }>,
  floors: ReturnType<typeof catalogueFloors>,
  at: string,
  d: Database,
): Pick<ClosedStep, 'evidence' | 'deferred' | 'satisfied'> {
  let deferred: ClosedStep['deferred']
  if (decision.defer) {
    const floor = floors.find((item) => item.kind === decision.defer?.floor)
    const inserted = d
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO workflow_obligation
          (cursor_id,step_ordinal,step_slug,floor,require_pull_request,expected_exit_code,
           expected_status,floor_deferrable,reason,session_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        row.id,
        row.ordinal + 1,
        row.step_slug,
        decision.defer.floor,
        floor?.requirePullRequest ? 1 : 0,
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
        WHERE id=? AND cursor_id=? AND satisfied_at IS NULL`,
    ).run(
      at,
      row.ordinal + 1,
      row.step_slug,
      JSON.stringify(decision.refs),
      decision.satisfyId,
      row.id,
    )
  }
  return {
    ...(decision.refs.length ? { evidence: decision.refs } : {}),
    ...(deferred ? { deferred } : {}),
    ...(decision.satisfyId ? { satisfied: decision.satisfyId } : {}),
  }
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
): string {
  const row = findCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  slug = row.workflow_slug
  project = row.project
  mode = row.mode_slug
  if (row.state === 'done' || row.state === 'abandoned')
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} is ${row.state}`)
  applyCursorArguments(row, args, d)
  adoptWorkflowTask(row, evidence.task, d)
  if (!note?.trim()) {
    const composition = cursorComposition(row, d)
    const step = composition.steps[row.ordinal]!
    throw new Error(
      `--note is required: one line saying how step ${step.n} ${step.slug}'s floor was met`,
    )
  }
  const composition = cursorComposition(row, d)
  const next = composition.steps[row.ordinal + 1] ?? null
  const decision = decideCursorTransition(cursorValue(row), {
    kind: 'next',
    total: composition.steps.length,
    nextSlug: next?.slug ?? null,
  })
  if (decision.action === 'refuse') {
    if (decision.reason === 'not-started') throw new Error(remedy(row, composition))
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} is ${row.state}`)
  }
  const floor = applyFloorDecision(
    row,
    composition,
    evidence,
    ports,
    decision.action === 'finish',
    d,
  )
  if (floor.action === 'refuse') throw new Error(floor.message)
  const at = nowIso()
  if (row.state === 'awaiting-ruling')
    closeOpenWorkflowQuestion(row.id, 'advanced-without-ruling', at, d)
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  const review = composition.steps[row.ordinal]?.resolvedAutonomy.value === 'review'
  closed.push({
    n: row.ordinal + 1,
    slug: row.step_slug,
    note: note.trim(),
    at,
    ...(review ? { review: true as const } : {}),
    ...persistFloorClose(
      row,
      floor,
      catalogueFloors(
        composition.steps[row.ordinal]!.floor,
        composition.steps[row.ordinal]!.deferrable ?? [],
        composition.steps[row.ordinal]!.expectedStatus,
        Boolean(composition.steps[row.ordinal]!.requirePullRequest),
      ),
      at,
      d,
    ),
  })
  if (decision.action === 'finish') {
    d.query(
      `UPDATE workflow_cursor SET state='done',closed=?,question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(JSON.stringify(closed), context.session ?? null, at, row.id)
    const closedSteps = closed.filter(isClosedStep)
    const reviews = closedSteps
      .filter((step) => step.review)
      .map((step) => `For your review: ${step.n}. ${step.slug} — ${step.note}`)
    return [
      `${cursorName(slug, mode, row.workflow_key, true)} is finished: ${closedSteps.length} steps closed.`,
      ...reviews,
    ].join('\n')
  }
  d.query(
    `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
  ).run(
    decision.ordinal,
    decision.slug,
    JSON.stringify(closed),
    context.session ?? null,
    at,
    row.id,
  )
  return renderWorkflowStep({
    ...getWorkflowStep(
      slug,
      project,
      decision.slug,
      JSON.parse(row.args),
      d,
      {
        mode,
        version: row.workflow_version,
        catalogueVersion: row.catalogue_version,
      },
      cursorAutonomy(row),
    ),
    cursor: row.id,
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
): string {
  return writeTransaction(
    () =>
      nextWorkflowStepImpl(slug, project, mode, args, note, context, evidence, ports, d, cursor),
    d,
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
  slug = row.workflow_slug
  project = row.project
  mode = row.mode_slug
  if (row.state === 'done' || row.state === 'abandoned')
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} is ${row.state}`)
  const at = nowIso()
  if (row.state === 'awaiting-ruling') closeOpenWorkflowQuestion(row.id, 'abandoned', at, d)
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
      WHERE cursor_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL`,
  ).run(at, reason.trim(), row.id)
  d.query(
    `UPDATE workflow_cursor SET state='abandoned',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
  ).run(JSON.stringify(closed), context.session ?? null, at, row.id)
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
  return writeTransaction(
    () => abandonWorkflowCursorImpl(slug, project, mode, args, reason, context, d, cursor),
    d,
  )
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
): { summary: CursorSummary & { questionId: number }; cursorId: number } {
  if (!question?.trim()) throw new Error('--question is required')
  const row = findCursor(project, slug, mode, args, context, d, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  if (row.state === 'done' || row.state === 'abandoned')
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} is ${row.state}`)
  applyCursorArguments(row, args, d)
  const at = nowIso()
  d.query(
    `UPDATE workflow_cursor SET state='awaiting-ruling',question=?,
     session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
  ).run(question.trim(), context.session ?? null, at, row.id)
  const open = d
    .query(
      `SELECT id FROM question
       WHERE workflow_cursor_id=? AND ${questionOpenSql('question')}`,
    )
    .get(row.id) as { id: number } | null
  let questionId: number
  if (open) {
    d.query(
      `UPDATE question SET question=?,workflow_key=?,workflow_step_ordinal=?,workflow_step_slug=?,
       revision=revision+1 WHERE id=?`,
    ).run(question.trim(), row.workflow_key || null, row.ordinal + 1, row.step_slug, open.id)
    enqueueQuestionRecord(d, open.id)
    questionId = open.id
  } else {
    const inserted = d
      .query(
        `INSERT INTO question
        (workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at,
         workflow_step_ordinal,workflow_step_slug)
       VALUES (?,?,?,?, 'workflow', ?,?,?) RETURNING id`,
      )
      .get(
        row.id,
        row.workflow_key || null,
        at,
        question.trim(),
        at,
        row.ordinal + 1,
        row.step_slug,
      ) as { id: number }
    enqueueQuestionRecord(d, inserted.id)
    questionId = inserted.id
  }
  return {
    summary: {
      id: row.id,
      n: row.ordinal + 1,
      slug: row.step_slug,
      state: 'awaiting-ruling',
      opened: false,
      questionId,
    },
    cursorId: row.id,
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
    const row = findCursor(project, slug, mode, args, context, d, cursor)
    if (!row)
      throw new Error(
        `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
      )
    if (row.state !== 'awaiting-ruling')
      throw new Error(`${cursorName(slug, mode, row.workflow_key)} is not awaiting a ruling`)
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
    const answeredBy = rulingActor(fromOperator, actor)
    const changed = d
      .query(
        `UPDATE question SET answer=?,answered_at=?,answered_by=?,answerer_kind=?,answer_channel=?,
          revision=revision+1
         WHERE workflow_cursor_id=? AND ${questionOpenSql('question')}`,
      )
      .run(ruling.trim(), at, answeredBy, fromOperator ? 'operator' : 'agent', channel, row.id)
    if (changed.changes !== 1)
      throw new Error(`${cursorName(slug, mode, row.workflow_key)} has no open question to rule on`)
    const question = d
      .query('SELECT id FROM question WHERE workflow_cursor_id=? AND answered_at=?')
      .get(row.id, at) as { id: number }
    auditQuestionMutation(
      { questionId: question.id, action: 'rule', actor, at, reason: ruling.trim(), adoptionReason },
      d,
    )
    enqueueQuestionRecord(d, question.id)
    d.query(
      `UPDATE workflow_cursor SET state='running',question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(adoptionReason ? null : (context.session ?? null), at, row.id)
    return {
      summary: `${cursorName(slug, mode, row.workflow_key, true)} is running at step ${row.ordinal + 1} ${row.step_slug}.`,
      questionId: question.id,
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
  const result = writeTransaction(
    () => awaitWorkflowRulingImpl(slug, project, mode, args, question, context, d, cursor),
    d,
  )
  notify('workflow', result.cursorId, d)
  return result.summary
}

export type CursorListOptions = {
  session?: string
  all?: boolean
  project?: string
  cwd?: string
}

export function workflowCursorProjectScope(
  options: Pick<CursorListOptions, 'all' | 'project' | 'session'>,
  cwdProject: string | undefined,
  cwd: string,
): string | undefined {
  if (options.all || (options.session && !options.project)) return undefined
  if (options.project) return options.project
  if (cwdProject) return cwdProject
  throw new Error(`cannot list workflow cursors from ${cwd}: pass --project, --session or --all`)
}

export function listWorkflowCursors(
  options: CursorListOptions = {},
  d: Database = db(),
): Array<CursorRow & { next_slug: string; line: string }> {
  const cwd = options.cwd ?? process.cwd()
  const cwdProject =
    options.all || options.project || options.session ? undefined : projectAt(cwd)?.name
  const project = workflowCursorProjectScope(options, cwdProject, cwd)
  const clauses = [`state NOT IN ('done','abandoned')`]
  const values: string[] = []
  if (project) {
    clauses.push('project=?')
    values.push(project)
  }
  if (options.session) {
    clauses.push('session_id=?')
    values.push(options.session)
  }
  const rows = d
    .query(`SELECT * FROM workflow_cursor WHERE ${clauses.join(' AND ')} ORDER BY updated_at,id`)
    .all(...values) as CursorRow[]
  return rows.map((row) => {
    const open = openObligations(row.id, d)
    const listed = {
      ...row,
      next_slug: cursorComposition(row, d).steps[row.ordinal + 1]?.slug ?? 'finished',
      obligations: open.map((item) => `${item.id}(${item.stepSlug}:${item.floor})`).join(','),
    }
    return { ...listed, line: renderWorkflowCursorLine(listed) }
  })
}

export function renderWorkflowCursorLine(
  row: CursorRow & { next_slug: string; obligations?: string },
): string {
  const question = row.question ? ` question: ${row.question}` : ''
  const obligations = row.obligations ? ` obligations: ${row.obligations}` : ''
  return `cursor ${row.id} ${row.workflow_slug} ${row.mode_slug} ${row.workflow_key || 'unassigned'} ${row.project} step ${row.ordinal + 1}/${row.total_steps} ${row.step_slug} ${row.state} next: ${row.next_slug}${question}${obligations}`
}
