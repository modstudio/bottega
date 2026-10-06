// concern: workflow cursor public handle text
/** Keeps public cursor notices and command/tool handle syntax consistent. */

export function workflowCursorReference(cursor: number): { cli: string; mcp: string } {
  return { cli: ` --cursor ${cursor}`, mcp: `cursor ${cursor}` }
}

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
