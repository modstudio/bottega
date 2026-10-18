// concern: workflows
/** Chooses one catalogue copy for a project read, without mixing local and hosted rows. */
import type { Database } from 'bun:sqlite'
import { effectiveProjectSpace } from '../project-space.ts'

function catalogueResolutionSpace(
  routedSpaceId: string | null,
  hostedHasProductionCatalogue: boolean,
): string | null {
  return routedSpaceId && hostedHasProductionCatalogue ? routedSpaceId : null
}

export function workflowResolutionSpace(input: {
  routedSpaceId: string | null
  hostedHasProductionCatalogue: boolean
  hostedHasSelectedWorkflow: boolean
}): string | null {
  return input.routedSpaceId &&
    input.hostedHasProductionCatalogue &&
    input.hostedHasSelectedWorkflow
    ? input.routedSpaceId
    : null
}

function hasProductionCatalogue(d: Database, spaceId: string): boolean {
  return Boolean(
    d
      .query(
        `SELECT 1 FROM step_catalogue c JOIN step_catalogue_version v ON v.catalogue_id=c.id
       WHERE c.slug='shared' AND c.space_id=? AND v.status='production'`,
      )
      .get(spaceId),
  )
}

export function projectCatalogueResolutionSpace(
  d: Database,
  project: string | null,
): string | null {
  const routedSpaceId = effectiveProjectSpace(d, project)
  return catalogueResolutionSpace(
    routedSpaceId,
    routedSpaceId !== null && hasProductionCatalogue(d, routedSpaceId),
  )
}

export function projectWorkflowResolutionSpace(
  d: Database,
  project: string,
  slug: string,
  version?: number,
): string | null {
  const routedSpaceId = effectiveProjectSpace(d, project)
  if (!routedSpaceId)
    return workflowResolutionSpace({
      routedSpaceId,
      hostedHasProductionCatalogue: false,
      hostedHasSelectedWorkflow: false,
    })
  const suffix = version === undefined ? "v.status='production'" : 'v.n=?'
  const hostedHasSelectedWorkflow = Boolean(
    d
      .query(
        `SELECT 1 FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
       WHERE w.slug=? AND w.space_id=? AND ${suffix}`,
      )
      .get(...(version === undefined ? [slug, routedSpaceId] : [slug, routedSpaceId, version])),
  )
  return workflowResolutionSpace({
    routedSpaceId,
    hostedHasProductionCatalogue: hasProductionCatalogue(d, routedSpaceId),
    hostedHasSelectedWorkflow,
  })
}
