// concern: workflows
/** Renders the public result of an already-persisted cursor advance. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowKeyOf as keyOf } from './workflow-cursor-arguments.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { cursorName, shellWord, workflowCursorReference } from './workflow-cursor-format.ts'
import {
  type CursorTrailEntry,
  completedWorkflowSummary,
  isClosedStep,
} from './workflow-cursor-trail.ts'
import {
  type CursorState,
  type decideConditionalAdvance,
  decideCursorStart,
  type decideCursorTransition,
  stepPass,
} from './workflow-cursor-transition.ts'
import { cursorAutonomyLines, renderWorkflowStep, withSelfRuling } from './workflow-render.ts'
import type { WorkflowSelfRulingInput } from './workflow-self-ruling-mutation.ts'
import { withWorkflowTextFacts } from './workflow-text.ts'
import { type composeWorkflow, getWorkflowStep } from './workflows.ts'

type LiveCursorAutonomy = NonNullable<Parameters<typeof cursorAutonomy>[1]>

type AdvanceRow = {
  id: number
  record_id: string
  workflow_slug: string
  project: string
  mode_slug: string
  workflow_key: string
  workflow_version: number
  workflow_version_record_id: string
  catalogue_version: number
  catalogue_version_record_id: string
  args: string
  autonomy: string | null
}

export function refuseInvalidServe(
  decision: ReturnType<typeof decideCursorTransition>,
  row: (AdvanceRow & { ordinal: number; state: string; workflow_key: string }) | null,
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
  throw new Error(renderWorkflowCursorRemedy(row!, composition.steps[row!.ordinal]!))
}

export function refuseTerminalCursor(row: {
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  state: CursorState
}): void {
  if (decideCursorStart(row.state) === 'retire')
    throw new Error(
      `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key)} is ${row.state}`,
    )
}

function renderWorkflowCursorRemedy(
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
  live?: LiveCursorAutonomy
}): string {
  const { row, composition, closed, advance, slug, project, mode, selfRuling, d, live } = input
  if (advance.ordinal === null) {
    const result = withSelfRuling(
      completedWorkflowSummary(cursorName(slug, mode, row.workflow_key, true), closed),
      selfRuling,
    )
    const autonomyLines = cursorAutonomyLines(composition)
    return autonomyLines.length ? `${autonomyLines.join('\n')}\n${result}` : result
  }
  const next = composition.steps[advance.ordinal]!
  const flow = closed.filter(isClosedStep)
  const rendered = renderWorkflowStep({
    ...withWorkflowTextFacts(
      getWorkflowStep(
        slug,
        project,
        next.slug,
        JSON.parse(row.args),
        d,
        {
          mode,
          version: row.workflow_version,
          versionRecordId: row.workflow_version_record_id,
          catalogueVersion: row.catalogue_version,
          catalogueVersionRecordId: row.catalogue_version_record_id,
        },
        cursorAutonomy(row, live),
      ),
      row.record_id,
      d,
    ),
    cursor: row.id,
    flow,
    pass: stepPass(flow, composition.steps, advance.ordinal),
  })
  return withSelfRuling(rendered, selfRuling)
}
