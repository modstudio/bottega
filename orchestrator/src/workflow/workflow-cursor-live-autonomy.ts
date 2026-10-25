// concern: workflow cursor live autonomy
/** Resolves current autonomy against the exact composition pinned by an open cursor. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import {
  type AutonomySettings,
  catalogueStepsForAutonomy,
  type LiveCursorAutonomy,
} from './autonomy.ts'
import { resolveProjectAutonomy } from './autonomy-scopes.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorComposition } from './workflow-cursor.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { selectWorkflowCursor, type WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { composeWorkflow, getWorkflowStep } from './workflows.ts'

type CursorLiveAutonomyInput = {
  slug: string
  project: string
  mode: string
  args: Record<string, string>
  context: WorkflowCursorContext
  cursor?: number
  session?: AutonomySettings
  selection?: { version?: number; catalogueVersion?: number }
}

type WorkflowLiveAutonomyInput = Omit<CursorLiveAutonomyInput, 'mode'> & {
  mode?: string
  step?: string
}

const errorReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export async function resolveCursorLiveAutonomy(
  input: CursorLiveAutonomyInput,
  d: Database = db(),
): Promise<LiveCursorAutonomy> {
  const row = selectWorkflowCursor(
    {
      project: input.project,
      workflow: input.slug,
      mode: input.mode,
      key: workflowKeyOf(input.args) || undefined,
    },
    input.cursor,
    input.context.session,
    d,
  )
  let composition: ReturnType<typeof composeWorkflow>
  try {
    composition = row
      ? cursorComposition(row, d)
      : composeWorkflow(input.slug, input.project, input.mode, input.args, d, {
          ...input.selection,
          mode: input.mode,
        })
    const stages = row ? Object.keys(cursorAutonomy(row)?.stages ?? {}) : []
    return {
      resolution: await resolveProjectAutonomy(
        composition.project,
        composition.workflow.slug,
        composition.workflow.defaultPreset,
        catalogueStepsForAutonomy(composition.steps),
        input.session,
        undefined,
        d,
        undefined,
        undefined,
        stages as Parameters<typeof resolveProjectAutonomy>[9],
      ),
    }
  } catch (error) {
    if (!row) throw error
    return { unavailableReason: errorReason(error) }
  }
}

export async function resolveWorkflowLiveAutonomy(
  input: WorkflowLiveAutonomyInput,
  d: Database = db(),
): Promise<LiveCursorAutonomy> {
  if (input.mode) return resolveCursorLiveAutonomy({ ...input, mode: input.mode }, d)
  const composition = composeWorkflow(
    input.slug,
    input.project,
    undefined,
    input.args,
    d,
    input.selection,
  )
  const steps = input.step
    ? [getWorkflowStep(input.slug, input.project, input.step, input.args, d, input.selection)]
    : composition.steps
  return {
    resolution: await resolveProjectAutonomy(
      input.project,
      composition.workflow.slug,
      composition.workflow.defaultPreset,
      catalogueStepsForAutonomy(steps),
      input.session,
      undefined,
      d,
    ),
  }
}
