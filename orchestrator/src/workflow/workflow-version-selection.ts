// concern: workflow version selection
/** Keeps cursor-pinned record-id lookups distinct from current version selection. */
import type { Database } from 'bun:sqlite'
import { selectedStepCatalogue, showPinnedStepCatalogue } from './step-catalogue.ts'
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
  return selection.catalogueVersionRecordId
    ? showPinnedStepCatalogue(selection.catalogueVersionRecordId, d)
    : selectedStepCatalogue(selection.catalogueVersion, d, spaceId)
}
