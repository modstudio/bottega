import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { notifyWaitingItem } from '../operator/operator-waiting.ts'
import { projectAt } from '../project/projects.ts'
import {
  auditQuestionMutation,
  authorizeWorkflowQuestionMutation,
} from '../run/question-mutation.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { rulingActor } from '../run/question-vocabulary.ts'
import type { AutonomyResolution } from './autonomy.ts'
import {
  type CursorState,
  type CursorValue,
  decideCursorStart,
  decideCursorTransition,
} from './workflow-cursor-transition.ts'
import { renderWorkflowStep } from './workflow-render.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import {
  composeWorkflow,
  getWorkflowStep,
  productionWorkflows,
  resolveWorkflowMode,
  showWorkflow,
} from './workflows.ts'

export type WorkflowCursorContext = {
  session?: string | null
  /** Used only for a keyless workflow when the harness supplies no session id. */
  instance?: string
}

type ClosedStep = { n: number; slug: string; note: string; at: string; review?: true }
type ArgumentReboundEvent = {
  event: 'argument-rebound'
  name: string
  oldValue: string
  newValue: string
  at: string
}
type CursorTrailEntry = ClosedStep | ArgumentReboundEvent
type CursorRow = {
  id: number
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  instance_id: string
  session_id: string | null
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
  ordinal: number
  step_slug: string
  state: CursorState
  closed: string
  question: string | null
  total_steps: number
  created_at: string
  updated_at: string
}

const MCP_INSTANCE = randomUUID()
export const mcpWorkflowCursorContext = (): WorkflowCursorContext => ({
  session: sessionId(),
  instance: MCP_INSTANCE,
})
export const cliWorkflowCursorContext = (): WorkflowCursorContext => ({ session: sessionId() })

/** A cursor is keyed by the task key the caller passed; production's argument list never decides identity. */
const keyOf = (args: Record<string, string>): string => args.key?.trim() ?? ''
const instanceOf = (key: string, context: WorkflowCursorContext): string => {
  if (key) return ''
  const instance = context.session ?? context.instance
  if (instance) return instance
  throw new Error(
    'keyless workflow cursor needs an identity; pass --arg key=<task key> or run under a harness that sets CLAUDE_CODE_SESSION_ID',
  )
}
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
       WHERE workflow_cursor_id=? AND answered_at IS NULL AND closed_at IS NULL`,
    )
    .all(cursorId)
  d.query(
    `UPDATE question SET closed_at=?,close_reason=?,revision=revision+1
     WHERE workflow_cursor_id=? AND answered_at IS NULL AND closed_at IS NULL`,
  ).run(at, reason, cursorId)
  for (const question of questions) enqueueQuestionRecord(d, question.id)
}

function findCursor(
  project: string,
  workflow: string,
  mode: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  d: Database,
): CursorRow | null {
  const key = keyOf(args)
  const row = d
    .query(
      `SELECT * FROM workflow_cursor
       WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=?`,
    )
    .get(project, workflow, mode, key, instanceOf(key, context)) as CursorRow | null
  return row
}

export function resolveWorkflowCursorMode(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  caller: string,
  remedy: string,
  d: Database = db(),
): string {
  if (requested) return requested
  const key = keyOf(args)
  const rows = d
    .query(
      `SELECT DISTINCT mode_slug FROM workflow_cursor
       WHERE project=? AND workflow_slug=? AND workflow_key=? AND instance_id=?
         AND state NOT IN ('done','abandoned')
       ORDER BY mode_slug`,
    )
    .all(project, slug, key, instanceOf(key, context)) as { mode_slug: string }[]
  if (rows.length === 1) return rows[0]!.mode_slug
  if (rows.length > 1) {
    throw new Error(
      `${caller} cannot resolve a mode for workflow "${slug}"; active cursor modes: ` +
        `${rows.map(({ mode_slug }) => mode_slug).join(', ')}; ${remedy}`,
    )
  }
  const definition = showWorkflow(slug, undefined, d).definition
  const mode = resolveWorkflowMode(definition)
  if (mode) return mode.slug
  throw new Error(
    `${caller} cannot resolve a default mode for workflow "${slug}"; ` +
      `modes: ${definition.modes.map(({ slug: modeSlug }) => modeSlug).join(', ')}; ${remedy}`,
  )
}

export type CursorArgumentDecision =
  | {
      action: 'merge'
      args: Record<string, string>
      rebindings: Array<{ name: string; oldValue: string; newValue: string }>
    }
  | { action: 'refuse'; reason: string }

export function decideCursorArguments(
  stored: Record<string, string>,
  supplied: Record<string, string>,
  rebindable: ReadonlySet<string>,
): CursorArgumentDecision {
  const merged = { ...stored }
  const rebindings: Array<{ name: string; oldValue: string; newValue: string }> = []
  for (const [name, suppliedValue] of Object.entries(supplied)) {
    if (!suppliedValue.trim()) continue
    const storedValue = stored[name]
    if (storedValue?.trim() && storedValue !== suppliedValue) {
      if (name !== 'key' && rebindable.has(name)) {
        merged[name] = suppliedValue
        rebindings.push({ name, oldValue: storedValue, newValue: suppliedValue })
        continue
      }
      return {
        action: 'refuse',
        reason:
          `workflow argument "${name}" conflicts with the cursor: stored value "${storedValue}", ` +
          `supplied value "${suppliedValue}"; run orch workflow abandon for this cursor, then compose again`,
      }
    }
    if (!storedValue?.trim()) merged[name] = suppliedValue
  }
  return { action: 'merge', args: merged, rebindings }
}

const isClosedStep = (entry: CursorTrailEntry): entry is ClosedStep => !('event' in entry)

function cursorRebindableArguments(row: CursorRow, d: Database): Set<string> {
  const current = productionWorkflows(d).find(({ slug }) => slug === row.workflow_slug)
  const definitions = [
    showWorkflow(row.workflow_slug, row.workflow_version, d).definition,
    ...(current ? [current.definition] : []),
  ]
  return new Set(
    definitions
      .flatMap((definition) => definition.arguments)
      .filter((argument) => argument.name !== 'key' && argument.rebind === true)
      .map((argument) => argument.name),
  )
}

function applyCursorArguments(
  row: CursorRow,
  supplied: Record<string, string>,
  d: Database,
): Record<string, string> {
  const decision = decideCursorArguments(
    JSON.parse(row.args) as Record<string, string>,
    supplied,
    cursorRebindableArguments(row, d),
  )
  if (decision.action === 'refuse') throw new Error(decision.reason)
  const encoded = JSON.stringify(decision.args)
  if (decision.rebindings.length) {
    const at = nowIso()
    const trail = JSON.parse(row.closed) as CursorTrailEntry[]
    trail.push(
      ...decision.rebindings.map(
        ({ name, oldValue, newValue }): ArgumentReboundEvent => ({
          event: 'argument-rebound',
          name,
          oldValue,
          newValue,
          at,
        }),
      ),
    )
    d.query('UPDATE workflow_cursor SET args=?,closed=?,updated_at=? WHERE id=?').run(
      encoded,
      JSON.stringify(trail),
      at,
      row.id,
    )
    row.args = encoded
    row.closed = JSON.stringify(trail)
  } else if (encoded !== row.args) {
    d.query('UPDATE workflow_cursor SET args=?,updated_at=? WHERE id=?').run(
      encoded,
      nowIso(),
      row.id,
    )
    row.args = encoded
  }
  return decision.args
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
  const instance = instanceOf(key, context)
  const at = nowIso()
  const existing = findCursor(
    composition.project,
    composition.workflow.slug,
    composition.mode!.slug,
    composition.arguments,
    context,
    d,
  )
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
       total_steps,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,'running','[]',NULL,?,?,?)
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
  return findCursor(
    composition.project,
    composition.workflow.slug,
    composition.mode!.slug,
    composition.arguments,
    context,
    d,
  )!
}

export type CursorSummary = {
  n: number
  slug: string
  state: CursorState
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
    const existing = findCursor(
      composition.project,
      composition.workflow.slug,
      composition.mode!.slug,
      composition.arguments,
      context,
      d,
    )
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
        n: row.ordinal === 0 ? 0 : row.ordinal + 1,
        slug: row.step_slug,
        state: row.state,
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

function getWorkflowStepWithCursorImpl(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
  autonomy?: AutonomyResolution,
) {
  let row = findCursor(project, slug, mode, args, context, d)
  const startDecision = decideCursorStart(row?.state ?? null)
  if (row && startDecision === 'reuse') applyCursorArguments(row, args, d)
  const { effectiveArgs, selection } = cursorCompositionInput(row, args, mode)
  const composition = composeWorkflow(
    slug,
    project,
    mode,
    effectiveArgs,
    d,
    selection,
    row ? cursorAutonomy(row) : autonomy,
  )
  const resolvedStepSlug = resolveWorkflowStepReference(stepSlug, [
    { mode, steps: composition.steps.map((step) => step.slug) },
  ])
  const index = composition.steps.findIndex((step) => step.slug === resolvedStepSlug)
  if (index < 0) throw new Error(`workflow "${slug}" has no step "${resolvedStepSlug}"`)
  const requested = composition.steps[index]!
  if (index === 0 && startDecision === 'retire') {
    row = insertCursor(composition, context, d, autonomy)
  }
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
  return getWorkflowStep(
    slug,
    project,
    resolvedStepSlug,
    effectiveArgs,
    d,
    selection,
    cursorAutonomy(row),
  )
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
) {
  return writeTransaction(
    () => getWorkflowStepWithCursorImpl(slug, project, stepSlug, args, mode, context, d, autonomy),
    d,
  )
}

function nextWorkflowStepImpl(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  note: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): string {
  const row = findCursor(project, slug, mode, args, context, d)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
  if (row.state === 'done' || row.state === 'abandoned')
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} is ${row.state}`)
  applyCursorArguments(row, args, d)
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
  return renderWorkflowStep(
    getWorkflowStep(
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
  )
}

export function nextWorkflowStep(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  note: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): string {
  return writeTransaction(
    () => nextWorkflowStepImpl(slug, project, mode, args, note, context, d),
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
): string {
  if (!reason?.trim()) throw new Error('--reason is required')
  const row = findCursor(project, slug, mode, args, context, d)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
    )
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
): string {
  return writeTransaction(
    () => abandonWorkflowCursorImpl(slug, project, mode, args, reason, context, d),
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
): { summary: CursorSummary; cursorId: number } {
  if (!question?.trim()) throw new Error('--question is required')
  const row = findCursor(project, slug, mode, args, context, d)
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
       WHERE workflow_cursor_id=? AND answered_at IS NULL AND closed_at IS NULL`,
    )
    .get(row.id) as { id: number } | null
  if (open) {
    d.query('UPDATE question SET question=?,workflow_key=?,revision=revision+1 WHERE id=?').run(
      question.trim(),
      row.workflow_key || null,
      open.id,
    )
    enqueueQuestionRecord(d, open.id)
  } else {
    const inserted = d
      .query(
        `INSERT INTO question
        (workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at)
       VALUES (?,?,?,?, 'workflow', ?) RETURNING id`,
      )
      .get(row.id, row.workflow_key || null, at, question.trim(), at) as { id: number }
    enqueueQuestionRecord(d, inserted.id)
  }
  return {
    summary: { n: row.ordinal + 1, slug: row.step_slug, state: 'awaiting-ruling' },
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
): string {
  if (!ruling?.trim()) throw new Error('--ruling is required')
  return writeTransaction(() => {
    const row = findCursor(project, slug, mode, args, context, d)
    if (!row)
      throw new Error(
        `${cursorName(slug, mode, keyOf(args))} has no cursor; compose the workflow first`,
      )
    if (row.state !== 'awaiting-ruling')
      throw new Error(`${cursorName(slug, mode, row.workflow_key)} is not awaiting a ruling`)
    const actor = sessionId()
    authorizeWorkflowQuestionMutation({
      owner: row.session_id,
      actor,
      fromOperator,
      subject: cursorName(slug, mode, row.workflow_key),
      action: 'rule',
    })
    const at = nowIso()
    const answeredBy = rulingActor(fromOperator, actor)
    const changed = d
      .query(
        `UPDATE question SET answer=?,answered_at=?,answered_by=?,answerer_kind=?,answer_channel=?,
          revision=revision+1
         WHERE workflow_cursor_id=? AND answered_at IS NULL AND closed_at IS NULL`,
      )
      .run(ruling.trim(), at, answeredBy, fromOperator ? 'operator' : 'agent', channel, row.id)
    if (changed.changes !== 1)
      throw new Error(`${cursorName(slug, mode, row.workflow_key)} has no open question to rule on`)
    const question = d
      .query('SELECT id FROM question WHERE workflow_cursor_id=? AND answered_at=?')
      .get(row.id, at) as { id: number }
    auditQuestionMutation(
      { questionId: question.id, action: 'rule', actor, at, reason: ruling.trim() },
      d,
    )
    enqueueQuestionRecord(d, question.id)
    d.query(
      `UPDATE workflow_cursor SET state='running',question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(context.session ?? null, at, row.id)
    return `${cursorName(slug, mode, row.workflow_key, true)} is running at step ${row.ordinal + 1} ${row.step_slug}.`
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
): CursorSummary {
  const result = writeTransaction(
    () => awaitWorkflowRulingImpl(slug, project, mode, args, question, context, d),
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
    const listed = {
      ...row,
      next_slug: cursorComposition(row, d).steps[row.ordinal + 1]?.slug ?? 'finished',
    }
    return { ...listed, line: renderWorkflowCursorLine(listed) }
  })
}

export function renderWorkflowCursorLine(row: CursorRow & { next_slug: string }): string {
  return `${row.workflow_slug} ${row.workflow_key} ${row.project} step ${row.ordinal + 1}/${row.total_steps} ${row.step_slug} ${row.state} next: ${row.next_slug}${row.question ? ` question: ${row.question}` : ''}`
}
