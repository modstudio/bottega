// concern: workflows
/** Persists an already-decided cursor advance and renders its next public state. */

import type { Database } from 'bun:sqlite'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { cursorName } from './workflow-cursor-format.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
import {
  type CursorTrailEntry,
  completedWorkflowSummary,
  isClosedStep,
} from './workflow-cursor-trail.ts'
import type { decideConditionalAdvance } from './workflow-cursor-transition.ts'
import { renderWorkflowStep, withSelfRuling } from './workflow-render.ts'
import type { WorkflowSelfRulingInput } from './workflow-self-ruling-mutation.ts'
import { withWorkflowTextFacts } from './workflow-text.ts'
import { type composeWorkflow, getWorkflowStep } from './workflows.ts'

type AdvanceRow = {
  id: number
  workflow_slug: string
  project: string
  mode_slug: string
  workflow_key: string
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
}

export function persistWorkflowAdvance(input: {
  row: AdvanceRow
  composition: ReturnType<typeof composeWorkflow>
  closed: CursorTrailEntry[]
  advance: ReturnType<typeof decideConditionalAdvance>
  context: WorkflowCursorContext
  slug: string
  project: string
  mode: string
  at: string
  selfRuling?: WorkflowSelfRulingInput
  d: Database
}): string {
  const { row, composition, closed, advance, context, slug, project, mode, at, selfRuling, d } =
    input
  if (advance.ordinal === null) {
    d.query(
      `UPDATE workflow_cursor SET state='done',closed=?,question=NULL,
       session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
    ).run(JSON.stringify(closed), context.session ?? null, at, row.id)
    return withSelfRuling(
      completedWorkflowSummary(cursorName(slug, mode, row.workflow_key, true), closed),
      selfRuling,
    )
  }
  const next = composition.steps[advance.ordinal]!
  d.query(
    `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE id=?`,
  ).run(advance.ordinal, next.slug, JSON.stringify(closed), context.session ?? null, at, row.id)
  const rendered = renderWorkflowStep({
    ...withWorkflowTextFacts(
      getWorkflowStep(
        slug,
        project,
        next.slug,
        JSON.parse(row.args),
        d,
        { mode, version: row.workflow_version, catalogueVersion: row.catalogue_version },
        cursorAutonomy(row),
      ),
      row.id,
      d,
    ),
    cursor: row.id,
    flow: closed.filter(isClosedStep),
  })
  return withSelfRuling(rendered, selfRuling)
}
