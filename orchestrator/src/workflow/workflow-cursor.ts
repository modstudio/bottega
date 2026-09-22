import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  type CursorState,
  type CursorValue,
  decideCursorTransition,
} from './workflow-cursor-transition.ts'
import { renderWorkflowStep } from './workflow-render.ts'
import { composeWorkflow, getWorkflowStep } from './workflows.ts'

export type WorkflowCursorContext = {
  session?: string | null
  /** Used only for a keyless workflow when the harness supplies no session id. */
  instance?: string
}

type ClosedStep = { n: number; slug: string; note: string; at: string }
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

const cursorValue = (row: CursorRow): CursorValue => ({
  ordinal: row.ordinal,
  stepSlug: row.step_slug,
  state: row.state,
})

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

/** The session that drove this cursor before the current one took it over, or null. */
const takenOverFrom = (row: CursorRow | null, context: WorkflowCursorContext): string | null =>
  row?.session_id && context.session && row.session_id !== context.session ? row.session_id : null

function insertCursor(
  composition: ReturnType<typeof composeWorkflow>,
  context: WorkflowCursorContext,
  d: Database,
): CursorRow {
  const key = keyOf(composition.arguments)
  const instance = instanceOf(key, context)
  const at = nowIso()
  d.query(
    `INSERT INTO workflow_cursor
      (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
       workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
       total_steps,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,'running','[]',NULL,?,?,?)
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
) {
  const composition = composeWorkflow(slug, project, mode, args, d, selection)
  if (!composition.mode || composition.needs.arguments) return { ...composition, cursor: null }
  return writeTransaction(() => {
    const previousSession = takenOverFrom(
      findCursor(
        composition.project,
        composition.workflow.slug,
        composition.mode!.slug,
        composition.arguments,
        context,
        d,
      ),
      context,
    )
    const row = insertCursor(composition, context, d)
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
  )
}

function remedy(row: CursorRow, composition: ReturnType<typeof composeWorkflow>): string {
  const active = composition.steps[row.ordinal]!
  const args = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return (
    `workflow ${row.workflow_slug} for ${row.workflow_key} is at step ${active.n} ${active.slug}; ` +
    `fetch that step, or close it with: orch workflow next ${row.workflow_slug} --project ${row.project} ` +
    `--mode ${row.mode_slug}${args} --note "<how its floor was met>"`
  )
}

function getWorkflowStepWithCursorImpl(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
) {
  let row = findCursor(project, slug, mode, args, context, d)
  const effectiveArgs = row ? (JSON.parse(row.args) as Record<string, string>) : args
  const selection = row
    ? { mode, version: row.workflow_version, catalogueVersion: row.catalogue_version }
    : { mode }
  const composition = composeWorkflow(slug, project, mode, effectiveArgs, d, selection)
  const index = composition.steps.findIndex((step) => step.slug === stepSlug)
  if (index < 0) throw new Error(`workflow "${slug}" has no step "${stepSlug}"`)
  const requested = composition.steps[index]!
  const decision = decideCursorTransition(row ? cursorValue(row) : null, {
    kind: 'serve',
    ordinal: index,
    slug: requested.slug,
    expectedOrdinal: row?.ordinal ?? -1,
    expectedSlug: row?.step_slug ?? composition.steps[0]!.slug,
  })
  if (decision.action === 'refuse') {
    if (decision.reason === 'compose-first')
      throw new Error(
        `workflow ${slug} for ${keyOf(args)} has no cursor; compose the workflow first`,
      )
    throw new Error(remedy(row!, composition))
  }
  if (decision.action !== 'serve') throw new Error('invalid serve transition')
  if (!row) row = insertCursor(composition, context, d)
  if (decision.move || decision.resume) {
    d.query(
      `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(decision.ordinal, decision.slug, context.session ?? null, nowIso(), row.id)
  }
  return getWorkflowStep(slug, project, stepSlug, effectiveArgs, d, selection)
}

export function getWorkflowStepWithCursor(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
) {
  return writeTransaction(
    () => getWorkflowStepWithCursorImpl(slug, project, stepSlug, args, mode, context, d),
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
    throw new Error(`workflow ${slug} for ${keyOf(args)} has no cursor; compose the workflow first`)
  if (row.state === 'done') throw new Error(`workflow ${slug} for ${row.workflow_key} is done`)
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
    throw new Error(`workflow ${slug} for ${row.workflow_key} is ${row.state}`)
  }
  const at = nowIso()
  const closed = JSON.parse(row.closed) as ClosedStep[]
  closed.push({ n: row.ordinal + 1, slug: row.step_slug, note: note.trim(), at })
  if (decision.action === 'finish') {
    d.query(
      `UPDATE workflow_cursor SET state='done',closed=?,question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(JSON.stringify(closed), context.session ?? null, at, row.id)
    return `Workflow ${slug} for ${row.workflow_key} is finished: ${closed.length} steps closed.`
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
    getWorkflowStep(slug, project, decision.slug, JSON.parse(row.args), d, {
      mode,
      version: row.workflow_version,
      catalogueVersion: row.catalogue_version,
    }),
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

function awaitWorkflowRulingImpl(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): CursorSummary {
  if (!question?.trim()) throw new Error('--question is required')
  const row = findCursor(project, slug, mode, args, context, d)
  if (!row)
    throw new Error(`workflow ${slug} for ${keyOf(args)} has no cursor; compose the workflow first`)
  if (row.state === 'done') throw new Error(`workflow ${slug} for ${row.workflow_key} is done`)
  d.query(
    `UPDATE workflow_cursor SET state='awaiting-ruling',question=?,
     session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
  ).run(question.trim(), context.session ?? null, nowIso(), row.id)
  return { n: row.ordinal + 1, slug: row.step_slug, state: 'awaiting-ruling' }
}

export function awaitWorkflowRuling(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  question: string | undefined,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): CursorSummary {
  return writeTransaction(
    () => awaitWorkflowRulingImpl(slug, project, mode, args, question, context, d),
    d,
  )
}

export type CursorListOptions = {
  session?: string
  all?: boolean
  project?: string
  cwd?: string
}

export function listWorkflowCursors(
  options: CursorListOptions = {},
  d: Database = db(),
): Array<CursorRow & { next_slug: string }> {
  const project = options.all
    ? undefined
    : (options.project ?? projectAt(options.cwd ?? process.cwd())?.name)
  const clauses = [`state <> 'done'`]
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
  return rows.map((row) => ({
    ...row,
    next_slug: cursorComposition(row, d).steps[row.ordinal + 1]?.slug ?? 'finished',
  }))
}

export function renderWorkflowCursorLine(
  row: ReturnType<typeof listWorkflowCursors>[number],
): string {
  return `${row.workflow_slug} ${row.workflow_key} ${row.project} step ${row.ordinal + 1}/${row.total_steps} ${row.step_slug} ${row.state} next: ${row.next_slug}${row.question ? ` question: ${row.question}` : ''}`
}
