// concern: workflows
/** Renders the public result of an already-persisted cursor advance. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { cursorName, shellWord, workflowCursorReference } from './workflow-cursor-format.ts'
import {
  type CursorTrailEntry,
  completedWorkflowSummary,
  isClosedStep,
} from './workflow-cursor-trail.ts'
import {
  type decideConditionalAdvance,
  stepPass,
} from './workflow-cursor-transition.ts'
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

export function renderWorkflowCursorRemedy(
  row: Pick<
    AdvanceRow,
    'id' | 'workflow_slug' | 'project' | 'mode_slug' | 'workflow_key' | 'args'
  > & { ordinal: number },
  active: { n: number; slug: string },
): string {
  const args = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return (
    `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key)} is at step ${active.n} ${active.slug}; ` +
    `fetch that step, or close it with: ${PLATFORM_SLUG} workflow next ${row.workflow_slug} --project ${row.project} ` +
    `--mode ${row.mode_slug}${workflowCursorReference(row.id).cli}${args} --note "<how its floor was met>"`
  )
}

export function renderWorkflowAdvanceResult(input: {
  row: AdvanceRow
  composition: ReturnType<typeof composeWorkflow>
  closed: CursorTrailEntry[]
  advance: ReturnType<typeof decideConditionalAdvance>
  slug: string
  project: string
  mode: string
  selfRuling?: WorkflowSelfRulingInput
  d: Database
}): string {
  const { row, composition, closed, advance, slug, project, mode, selfRuling, d } = input
  if (advance.ordinal === null) {
    return withSelfRuling(
      completedWorkflowSummary(cursorName(slug, mode, row.workflow_key, true), closed),
      selfRuling,
    )
  }
  const next = composition.steps[advance.ordinal]!
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
    pass: stepPass(closed.filter(isClosedStep), composition.steps, advance.ordinal),
  })
  return withSelfRuling(rendered, selfRuling)
}
