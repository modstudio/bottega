// concern: workflow cursor arguments
/** Merges late workflow arguments and records the explicitly rebindable changes. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import type { ArgumentReboundEvent, CursorTrailEntry } from './workflow-cursor-trail.ts'
import { productionWorkflows, showWorkflow } from './workflows.ts'

type ArgumentCursor = {
  id: number
  workflow_slug: string
  workflow_version: number
  args: string
  closed: string
}

export const workflowKeyOf = (args: Record<string, string>): string => args.key?.trim() ?? ''

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
          `supplied value "${suppliedValue}"`,
      }
    }
    if (!storedValue?.trim()) merged[name] = suppliedValue
  }
  return { action: 'merge', args: merged, rebindings }
}

function rebindableArguments(row: ArgumentCursor, d: Database): Set<string> {
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

export function applyCursorArguments(
  row: ArgumentCursor,
  supplied: Record<string, string>,
  d: Database,
): Record<string, string> {
  const decision = decideCursorArguments(
    JSON.parse(row.args) as Record<string, string>,
    supplied,
    rebindableArguments(row, d),
  )
  if (decision.action === 'refuse')
    throw new Error(`${decision.reason}; orch workflow abandon --cursor ${row.id} --reason "<why>"`)
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
