// concern: workflows
/** Renders the public result of an already-persisted cursor advance. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
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
  workflowCursorStepSuccessor,
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

export function refuseMissingCloseNote(
  note: string | undefined,
  n: number,
  slug: string,
): asserts note is string {
  if (!note?.trim())
    throw new Error(`--note is required: one line saying how step ${n} ${slug}'s floor was met`)
}

export function refuseMissingAbandonReason(reason: string | undefined): asserts reason is string {
  if (!reason?.trim()) throw new Error('--reason is required')
}

export function persistedAdvanceRenderFailure(input: {
  row: Pick<AdvanceRow, 'id' | 'workflow_slug' | 'project' | 'mode_slug' | 'args'>
  closed: { n: number; slug: string }
  active: { n: number; slug: string }
  error: unknown
}): Error {
  const { row, closed, active, error } = input
  const carriedArgs = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  const fetch =
    `${PLATFORM_SLUG} workflow step ${shellWord(row.workflow_slug)} ${shellWord(active.slug)} ` +
    `--mode ${shellWord(row.mode_slug)}${workflowCursorReference(row.id, row.project).cli}${carriedArgs}`
  const cause = error instanceof Error ? error.message : String(error)
  return new Error(
    `Step ${closed.n} ${closed.slug} closed. Step ${active.n} ${active.slug} is now active.\n` +
      `${cause}\nFetch the now-active step with: ${fetch}`,
  )
}

export function workflowAdvanceResultText(input: {
  takeoverNotice: string | null
  rendered: string
  floorNotices: readonly string[]
  taskLinkNotice?: string | null
  keptTextNotice: string
  claimWarning: string | null
}): string {
  return [
    input.takeoverNotice,
    input.rendered,
    ...input.floorNotices,
    input.taskLinkNotice,
    input.keptTextNotice,
    input.claimWarning,
  ]
    .filter(Boolean)
    .join('\n')
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
    `fetch that step, or close it with: ${PLATFORM_SLUG} workflow next ${row.workflow_slug} ` +
    `--mode ${row.mode_slug}${workflowCursorReference(row.id, row.project).cli}${args} --note "<how its floor was met>"`
  )
}

export async function renderWorkflowAdvanceResult(input: {
  row: AdvanceRow
  composition: ReturnType<typeof composeWorkflow>
  closed: CursorTrailEntry[]
  advance: ReturnType<typeof decideConditionalAdvance>
  slug: string
  project: string
  mode: string
  selfRuling?: WorkflowSelfRulingInput
  d: Database
  client?: RecordTaskFlowClient
  live?: LiveCursorAutonomy
}): Promise<string> {
  const { row, composition, closed, advance, slug, project, mode, selfRuling, d, client, live } =
    input
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
    ...(await withWorkflowTextFacts(
      await getWorkflowStep(
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
      client,
    )),
    cursor: row.id,
    flow,
    pass: stepPass(flow, composition.steps, advance.ordinal),
    next: workflowCursorStepSuccessor(composition.steps, flow, advance.ordinal),
  })
  return withSelfRuling(rendered, selfRuling)
}

export async function renderPersistedWorkflowAdvanceResult(
  input: Parameters<typeof renderWorkflowAdvanceResult>[0] & {
    closedStep: { n: number; slug: string }
  },
): Promise<string> {
  try {
    return await renderWorkflowAdvanceResult(input)
  } catch (error) {
    if (input.advance.ordinal === null) throw error
    const active = input.composition.steps[input.advance.ordinal]!
    throw persistedAdvanceRenderFailure({
      row: input.row,
      closed: input.closedStep,
      active,
      error,
    })
  }
}
