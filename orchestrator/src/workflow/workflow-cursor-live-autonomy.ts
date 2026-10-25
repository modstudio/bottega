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
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { selectWorkflowCursor, type WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { composeWorkflow } from './workflows.ts'

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
  const storedArgs = row ? (JSON.parse(row.args) as Record<string, string>) : {}
  const effectiveArgs = { ...storedArgs, ...input.args }
  let composition: ReturnType<typeof composeWorkflow>
  try {
    composition = composeWorkflow(
      row?.workflow_slug ?? input.slug,
      row?.project ?? input.project,
      row?.mode_slug ?? input.mode,
      effectiveArgs,
      d,
      row
        ? { version: row.workflow_version, catalogueVersion: row.catalogue_version }
        : { ...input.selection, mode: input.mode },
      row ? cursorAutonomy(row) : undefined,
    )
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
