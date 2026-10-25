// concern: workflow version selection
/** Keeps cursor-pinned record-id lookups distinct from current version selection. */
import type { Database } from 'bun:sqlite'
import {
  compatibleCatalogueStep,
  type StepCatalogueDefinition,
  selectedStepCatalogue,
} from './step-catalogue.ts'
import type { WorkflowDefinition } from './workflow-definition.ts'

export type WorkflowSelection = {
  version?: number
  versionRecordId?: string
  catalogueVersion?: number
  catalogueVersionRecordId?: string
  mode?: string
}

export type WorkflowNeeds = {
  mode?: { slug: string; title: string; entry: string }[]
  arguments?: { name: string; description: string }[]
}

export function showPinnedWorkflow(recordId: string, d: Database) {
  const row = d
    .query(
      'SELECT v.*,w.slug FROM workflow_version v JOIN workflow w ON w.record_id=v.workflow_record_id WHERE v.record_id=?',
    )
    .get(recordId) as ({ definition: string } & Record<string, unknown>) | null
  if (!row) throw new Error(`pinned workflow version ${recordId} does not exist`)
  return { ...row, definition: JSON.parse(row.definition) as WorkflowDefinition }
}

export function selectWorkflowVersion<T>(
  selection: WorkflowSelection,
  d: Database,
  current: () => T,
): T {
  return selection.versionRecordId
    ? (showPinnedWorkflow(selection.versionRecordId, d) as T)
    : current()
}

export function selectCatalogueVersion(
  selection: WorkflowSelection,
  d: Database,
  spaceId: string | null,
) {
  if (!selection.catalogueVersionRecordId)
    return selectedStepCatalogue(selection.catalogueVersion, d, spaceId)
  const row = d
    .query(
      'SELECT v.*,i.slug FROM step_catalogue_version v JOIN step_catalogue i ON i.record_id=v.catalogue_record_id WHERE v.record_id=?',
    )
    .get(selection.catalogueVersionRecordId) as
    | ({ definition: string } & Record<string, unknown>)
    | null
  if (!row)
    throw new Error(
      `pinned step catalogue version ${selection.catalogueVersionRecordId} does not exist`,
    )
  const definition = JSON.parse(row.definition) as StepCatalogueDefinition
  return {
    ...row,
    definition: {
      steps: definition.steps.map(compatibleCatalogueStep),
      ...(definition.sequences === undefined ? {} : { sequences: definition.sequences }),
    },
  } as ReturnType<typeof selectedStepCatalogue>
}
