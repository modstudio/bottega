// concern: workflow cursor public handle text
/** Keeps public cursor notices and command/tool handle syntax consistent. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { CursorRepinnedEvent, CursorTrailEntry } from './workflow-cursor-trail.ts'
import { foreignCursorOwner } from './workflow-cursor-transition.ts'

export const WORKFLOW_CURSOR_QUESTION_SUMMARY_CHARS = 120
export const workflowCursorListCommand = `${PLATFORM_SLUG} workflow cursors`

export const workflowCursorNumberOption = (cursor: number | '<n>'): string => ` --cursor ${cursor}`

export function unresolvedHubTaskKeyRefusal(key: string): string {
  return `task key ${key} names no task in hub; check it with \`${PLATFORM_SLUG} task show ${key}\` or file the task first`
}

export function workflowCursorReference(
  cursor: number,
  project: string,
): { cli: string; mcp: string } {
  return {
    cli: ` --cursor ${cursor} --project ${shellWord(project)}`,
    mcp: `cursor ${cursor}, project ${JSON.stringify(project)}`,
  }
}

export const workflowTaskBindingCommand = (row: {
  id: number
  workflow_slug: string
  project: string
}) =>
  `${PLATFORM_SLUG} workflow next ${row.workflow_slug}${workflowCursorReference(row.id, row.project).cli} --task <KEY>`

export function formatCursorOpened(input: {
  cursor: number
  workflow: string
  mode: string
  key: string
  step: number
  stepSlug: string
}): string {
  return `Cursor ${input.cursor} was opened for workflow ${input.workflow} and mode ${input.mode}, ${input.key ? `for ${input.key}` : 'unassigned'}, at step ${input.step} ${input.stepSlug}.`
}

export function formatCursorResumed(input: {
  cursor: number
  key: string
  step: number
  stepSlug: string
}): string {
  return `Cursor ${input.cursor} is already open at step ${input.step} ${input.stepSlug} for ${input.key}.`
}

export function workflowCursorComposeCommand(row: {
  workflow_slug: string
  project: string
  mode_slug: string
  args: string
}): string {
  return workflowComposeCommand(
    row.workflow_slug,
    row.project,
    row.mode_slug,
    JSON.parse(row.args) as Record<string, string>,
  )
}

export function workflowComposeCommand(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
): string {
  const renderedArgs = Object.entries(args)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return (
    `${PLATFORM_SLUG} workflow compose ${shellWord(slug)} ` +
    `--project ${shellWord(project)} --mode ${shellWord(mode)}${renderedArgs}`
  )
}

export function workflowCursorResetRemedy(
  cursor: { id: number; composeCommand: string },
  project: string,
): string {
  return `${PLATFORM_SLUG} workflow abandon${workflowCursorReference(cursor.id, project).cli} --reason "<why>"; then start a new run with: ${cursor.composeCommand}`
}

export function workflowCursorTakeoverRemedy(
  row: {
    id: number
    workflow_slug: string
    workflow_key: string | null
    project: string
    mode_slug: string
    args: string
  },
  ownerSession: string,
): string {
  const compose = workflowCursorComposeCommand(row)
  if (row.workflow_key) return compose
  return (
    `${PLATFORM_SLUG} workflow abandon${workflowCursorReference(row.id, row.project).cli} ` +
    `--owner-session ${shellWord(ownerSession)}; then compose a new cursor with: ${compose}`
  )
}

export function foreignCursorOwnerNotice(
  row: {
    id: number
    session_id: string | null
    workflow_slug: string
    workflow_key: string | null
    project: string
    mode_slug: string
    args: string
  },
  callerSession: string | null | undefined,
): string | undefined {
  const owner = foreignCursorOwner(row, callerSession)
  if (!owner) return undefined
  return (
    `Notice: this cursor is owned by session ${owner}. Take it over with: ` +
    workflowCursorTakeoverRemedy(row, owner)
  )
}

export const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

export const cursorName = (slug: string, mode: string, key: string, capitalized = false) =>
  `${capitalized ? 'Workflow' : 'workflow'} ${slug}${key ? ` for ${key}` : ` (${mode})`}`

function workflowCursorQuestionSummary(question: string): string {
  const lines = question.split(/\r\n|\r|\n/)
  const first = lines.find((line) => line.trim())?.trim() ?? ''
  const summary = first.replace(/\s+/g, ' ')
  const codePoints = Array.from(summary)
  const cut = lines.length > 1 || codePoints.length > WORKFLOW_CURSOR_QUESTION_SUMMARY_CHARS
  if (!cut) return summary
  return `${codePoints.slice(0, WORKFLOW_CURSOR_QUESTION_SUMMARY_CHARS - 1).join('')}…`
}

/** One listed cursor as a single line of command output. */
export function renderWorkflowCursorLine(row: {
  id: number
  workflow_slug: string
  mode_slug: string
  workflow_key: string | null
  project: string | null
  ordinal: number
  total_steps: number
  step_slug: string
  state: string
  next_slug: string
  question?: string | null
  question_number?: number | null
  obligations?: string
  closed?: string
  handed_off_from_number?: number | null
  handed_off_from_workflow?: string | null
}): string {
  const question = row.question
    ? ` question${row.question_number == null ? '' : ` q${row.question_number}`}: ${workflowCursorQuestionSummary(row.question)} (full text: ${PLATFORM_SLUG} question inbox)`
    : ''
  const obligations = row.obligations ? ` obligations: ${row.obligations}` : ''
  const handoff =
    row.handed_off_from_number && row.handed_off_from_workflow
      ? ` handed off from ${row.handed_off_from_workflow} cursor ${row.handed_off_from_number}`
      : ''
  const repinned = (JSON.parse(row.closed ?? '[]') as CursorTrailEntry[]).findLast(
    (entry): entry is CursorRepinnedEvent => 'event' in entry && entry.event === 'repinned',
  )
  const repin = repinned
    ? ` repinned workflow ${repinned.workflow.from}->${repinned.workflow.to} catalogue ${repinned.catalogue.from}->${repinned.catalogue.to}`
    : ''
  return `cursor ${row.id} ${row.workflow_slug} ${row.mode_slug} ${row.workflow_key || 'unassigned'} ${row.project} step ${row.ordinal + 1}/${row.total_steps} ${row.step_slug} ${row.state} next: ${row.next_slug}${repin}${handoff}${question}${obligations}`
}
