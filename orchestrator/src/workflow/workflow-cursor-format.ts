// concern: workflow cursor public handle text
/** Keeps public cursor notices and command/tool handle syntax consistent. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export function workflowCursorReference(cursor: number): { cli: string; mcp: string } {
  return { cli: ` --cursor ${cursor}`, mcp: `cursor ${cursor}` }
}

export const workflowTaskBindingCommand = (row: { id: number; workflow_slug: string }) =>
  `${PLATFORM_SLUG} workflow next ${row.workflow_slug} --cursor ${row.id} --task <KEY>`

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

export const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

export const cursorName = (slug: string, mode: string, key: string, capitalized = false) =>
  `${capitalized ? 'Workflow' : 'workflow'} ${slug}${key ? ` for ${key}` : ` (${mode})`}`

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
  obligations?: string
}): string {
  const question = row.question ? ` question: ${row.question}` : ''
  const obligations = row.obligations ? ` obligations: ${row.obligations}` : ''
  return `cursor ${row.id} ${row.workflow_slug} ${row.mode_slug} ${row.workflow_key || 'unassigned'} ${row.project} step ${row.ordinal + 1}/${row.total_steps} ${row.step_slug} ${row.state} next: ${row.next_slug}${question}${obligations}`
}
