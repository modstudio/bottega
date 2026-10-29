// concern: workflow cursor arguments
/** Merges late workflow arguments and records the explicitly rebindable changes. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { nowIso } from '../database/db.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'
import type { ArgumentReboundEvent, CursorTrailEntry } from './workflow-cursor-trail.ts'
import { showPinnedWorkflow } from './workflow-version-selection.ts'
import { resolvedProductionWorkflows, showResolvedWorkflow } from './workflows.ts'

type ArgumentCursor = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  workflow_version: number
  workflow_version_record_id?: string
  args: string
  closed: string
  ordinal: number
  step_slug: string
}

export const workflowKeyOf = (args: Record<string, string>): string => args.key?.trim() ?? ''

export type CursorArgumentDecision =
  | {
      action: 'merge'
      args: Record<string, string>
      rebindings: Array<{ name: string; oldValue: string; newValue: string }>
    }
  | { action: 'refuse'; reason: string }
  | {
      action: 'refuse'
      kind: 'compose-branch'
      storedBranch: string
      suppliedBranch: string
    }

function composeBranchRebindConflict(
  stored: Record<string, string>,
  supplied: Record<string, string>,
  rebindable: ReadonlySet<string>,
  composing: boolean,
): { storedBranch: string; suppliedBranch: string } | null {
  const storedBranch = stored.branch?.trim()
  const suppliedBranch = supplied.branch?.trim()
  if (
    !composing ||
    !storedBranch ||
    !suppliedBranch ||
    suppliedBranch === storedBranch ||
    !rebindable.has('branch')
  )
    return null
  return { storedBranch: stored.branch!, suppliedBranch: supplied.branch! }
}

function decideCursorArgumentMerge(
  stored: Record<string, string>,
  supplied: Record<string, string>,
  rebindable: ReadonlySet<string>,
): CursorArgumentDecision {
  const merged = { ...stored }
  const rebindings: Array<{ name: string; oldValue: string; newValue: string }> = []
  for (const [name, suppliedValue] of Object.entries(supplied)) {
    if (!suppliedValue.trim()) continue
    const storedValue = stored[name]
    if (name === 'key' && !storedValue?.trim()) continue
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

export function decideCursorArguments(
  stored: Record<string, string>,
  supplied: Record<string, string>,
  rebindable: ReadonlySet<string>,
  composing = false,
): CursorArgumentDecision {
  const branchConflict = composeBranchRebindConflict(stored, supplied, rebindable, composing)
  return branchConflict
    ? {
        action: 'refuse',
        kind: 'compose-branch',
        ...branchConflict,
      }
    : decideCursorArgumentMerge(stored, supplied, rebindable)
}

function rebindableArguments(row: ArgumentCursor, d: Database): Set<string> {
  const current = resolvedProductionWorkflows(row.project, d).find(
    ({ slug }) => slug === row.workflow_slug,
  )
  const definitions = [
    (row.workflow_version_record_id
      ? showPinnedWorkflow(row.workflow_version_record_id, d)
      : showResolvedWorkflow(row.workflow_slug, row.workflow_version, row.project, d)
    ).definition,
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
  composing = false,
): Record<string, string> {
  const stored = JSON.parse(row.args) as Record<string, string>
  const rebindable = rebindableArguments(row, d)
  const decision = decideCursorArguments(stored, supplied, rebindable, composing)
  if (decision.action === 'refuse') {
    if ('kind' in decision) {
      const cursor = workflowCursorReference(row.id).cli
      throw new Error(
        `workflow compose cannot rebind open cursor ${row.id} from stored branch "${decision.storedBranch}" ` +
          `at step ${row.ordinal + 1} ${row.step_slug}; finish it with ` +
          `${PLATFORM_SLUG} workflow next ${row.workflow_slug}${cursor}, or abandon it with ` +
          `${PLATFORM_SLUG} workflow abandon ${row.workflow_slug}${cursor} --reason "<text>"; ` +
          `a renamed branch of the same change continues through ` +
          `${PLATFORM_SLUG} workflow next ${row.workflow_slug}${cursor} with the new branch`,
      )
    }
    throw new Error(
      `${decision.reason}; ${PLATFORM_SLUG} workflow abandon${workflowCursorReference(row.id).cli} --reason "<why>"`,
    )
  }
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
    d.query('UPDATE workflow_cursor SET args=?,closed=?,updated_at=? WHERE record_id=?').run(
      encoded,
      JSON.stringify(trail),
      at,
      row.record_id,
    )
    row.args = encoded
    row.closed = JSON.stringify(trail)
  } else if (encoded !== row.args) {
    d.query('UPDATE workflow_cursor SET args=?,updated_at=? WHERE record_id=?').run(
      encoded,
      nowIso(),
      row.record_id,
    )
    row.args = encoded
  }
  return decision.args
}
