// concern: workflows
/** Chooses the authoritative catalogue copy for a project read. */
import type { Database } from 'bun:sqlite'
import { effectiveProjectSpace } from '../project-space.ts'

export function workflowResolutionSpace(routedSpaceId: string | null): string | null {
  return routedSpaceId
}

export function projectCatalogueResolutionSpace(
  d: Database,
  project: string | null,
): string | null {
  return workflowResolutionSpace(effectiveProjectSpace(d, project))
}

export function projectWorkflowResolutionSpace(
  d: Database,
  project: string | null,
  _slug: string,
  _version?: number,
): string | null {
  return workflowResolutionSpace(effectiveProjectSpace(d, project))
}
