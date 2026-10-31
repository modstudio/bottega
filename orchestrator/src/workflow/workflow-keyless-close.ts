// concern: workflow keyless cursor close
/** Refuses a close that omits the key requested by a rendered tracker action. */

import type { Database } from 'bun:sqlite'
import type { LiveCursorAutonomy } from './autonomy.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { workflowTaskBindingCommand } from './workflow-cursor-format.ts'
import { KEYLESS_TRACKER_ACTION_KEY } from './workflow-template.ts'
import { getWorkflowStep } from './workflows.ts'

type KeylessCloseCursor = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  args: string
  ordinal: number
  step_slug: string
  workflow_version: number
  workflow_version_record_id: string
  catalogue_version: number
  catalogue_version_record_id: string
  autonomy: string | null
}

export function shouldRefuseKeylessStepClose(
  keylessTrackerActionPaths: readonly string[],
  suppliedTask: string | undefined,
): boolean {
  return keylessTrackerActionPaths.length > 0 && !suppliedTask?.trim()
}

export function refuseKeylessStepClose(
  row: KeylessCloseCursor,
  suppliedTask: string | undefined,
  d: Database,
  live?: LiveCursorAutonomy,
): void {
  if (row.workflow_key || suppliedTask?.trim()) return
  const step = getWorkflowStep(
    row.workflow_slug,
    row.project,
    row.step_slug,
    JSON.parse(row.args),
    d,
    {
      mode: row.mode_slug,
      version: row.workflow_version,
      versionRecordId: row.workflow_version_record_id,
      catalogueVersion: row.catalogue_version,
      catalogueVersionRecordId: row.catalogue_version_record_id,
    },
    cursorAutonomy(row, live),
  )
  if (shouldRefuseKeylessStepClose(step.keylessTrackerActionPaths ?? [], suppliedTask))
    throw new Error(
      `step ${row.ordinal + 1} ${step.slug} used ${KEYLESS_TRACKER_ACTION_KEY}; close it with: ${workflowTaskBindingCommand(row)}`,
    )
}
