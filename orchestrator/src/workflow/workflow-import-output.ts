// concern: workflow-import-output
/** Formats the per-item outcomes of a workflow tree import. */
import type { WorkflowTreeImportResult } from './workflow-tree-store.ts'

export function workflowImportLines(result: WorkflowTreeImportResult): string[] {
  return [
    result.catalogue.status === 'created'
      ? `catalogue: created draft ${result.catalogue.n}`
      : 'catalogue: no change',
    ...result.workflowOutcomes
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((outcome) =>
        outcome.status === 'created'
          ? `${outcome.slug}: created draft ${outcome.n}`
          : `${outcome.slug}: no change`,
      ),
  ]
}
