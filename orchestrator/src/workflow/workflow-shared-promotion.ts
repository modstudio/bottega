// concern: workflow-shared-promotion
/** Decides which catalogue spaces follow a shared workflow promotion. */
export type WorkflowPromotionVersion = {
  spaceId: string | null
  n: number
  status: 'draft' | 'production' | 'retired'
  author: string
  definition: string
  reason?: string
}

export const SHARED_WORKFLOW_PROMOTION_REASON = 'shared promotion:'

export const sharedWorkflowReachableSpaces = (
  spaces: readonly (string | null)[],
  blockedSpaces: readonly (string | null)[],
): (string | null)[] => spaces.filter((spaceId) => !blockedSpaces.includes(spaceId))

export type WorkflowPromotionSpaceDecision = {
  changed: (string | null)[]
  overrides: string[]
  pinned: string[]
  blockedByCatalogue?: WorkflowCatalogueBlock[]
}

type WorkflowCatalogueBlock = {
  space: string
  disposition: 'override' | 'pinned'
  plannedVersion: number
  reason: string
}

export type WorkflowCatalogueBlockBySpace = Omit<WorkflowCatalogueBlock, 'space'> & {
  spaceId: string | null
}

export type WorkflowPromotionReport = {
  version: number
  changedSpaces: string[]
  overrideSpaces: string[]
  pinnedSpaces: string[]
  blockedByCatalogue?: WorkflowCatalogueBlock[]
}

export const workflowPromotionReport = (
  version: number,
  decision: WorkflowPromotionSpaceDecision,
): WorkflowPromotionReport => ({
  version,
  changedSpaces: decision.changed.map((spaceId) => spaceId ?? 'local'),
  overrideSpaces: decision.overrides,
  pinnedSpaces: decision.pinned,
  ...(decision.blockedByCatalogue?.length
    ? { blockedByCatalogue: decision.blockedByCatalogue }
    : {}),
})

export const sharedPromotionTarget = (
  spaceId: string | null,
  disposition: 'follower' | 'override' | 'pinned',
  plannedVersion: number | 'none',
): string =>
  `space ${spaceId ?? 'local'} catalogue ${disposition} planned version ${plannedVersion}`

export const sharedPromotionRefusal = (
  slug: string,
  target: string,
  reason: string,
  cause?: unknown,
): Error =>
  new Error(
    `refusing shared workflow promotion for "${slug}": ${target} cannot carry the workflow: ${reason}`,
    { cause },
  )

const pinsSharedPromotion = (
  spaceId: string | null,
  sourceSpace: string,
  versions: readonly WorkflowPromotionVersion[],
): boolean => {
  if (spaceId === sourceSpace) return false
  const production = versions.find((version) => version.status === 'production')
  const highestCompletedVersion = versions.reduce(
    (highest, version) => (version.status === 'draft' ? highest : Math.max(highest, version.n)),
    0,
  )
  return production !== undefined && production.n < highestCompletedVersion
}

export const sharedWorkflowPromotionDisposition = (
  spaceId: string | null,
  versions: readonly WorkflowPromotionVersion[],
  sourceSpace: string,
): 'follower' | 'override' | 'pinned' => {
  const sourceVersions = new Map(
    versions.filter((row) => row.spaceId === sourceSpace).map((row) => [row.n, row.definition]),
  )
  const rows = versions.filter((row) => row.spaceId === spaceId)
  if (rows.some((row) => sourceVersions.get(row.n) !== row.definition)) return 'override'
  return pinsSharedPromotion(spaceId, sourceSpace, rows) ? 'pinned' : 'follower'
}

export function preflightSharedWorkflowTargets<Definition, CatalogueDefinition>(input: {
  slug: string
  definition: Definition
  sourceSpace: string
  spaces: readonly (string | null)[]
  catalogueVersions: readonly WorkflowPromotionVersion[]
  sourceCatalogue: WorkflowPromotionVersion
  missingCatalogueRefusal: string
  preflight(definition: Definition, spaceId: string | null, catalogue: CatalogueDefinition): void
}): WorkflowCatalogueBlockBySpace[] {
  const blocked: WorkflowCatalogueBlockBySpace[] = []
  for (const spaceId of input.spaces) {
    const disposition = sharedWorkflowPromotionDisposition(
      spaceId,
      input.catalogueVersions,
      input.sourceSpace,
    )
    const catalogue =
      disposition === 'follower'
        ? input.sourceCatalogue
        : input.catalogueVersions.find(
            (version) => version.spaceId === spaceId && version.status === 'production',
          )
    const target = sharedPromotionTarget(spaceId, disposition, catalogue?.n ?? 'none')
    if (!catalogue) throw sharedPromotionRefusal(input.slug, target, input.missingCatalogueRefusal)
    try {
      input.preflight(input.definition, spaceId, JSON.parse(catalogue.definition))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (disposition !== 'follower') {
        blocked.push({
          spaceId,
          disposition,
          plannedVersion: catalogue.n,
          reason,
        })
        continue
      }
      throw sharedPromotionRefusal(input.slug, target, reason)
    }
  }
  return blocked
}

/** A space follows while every version it holds matches the source history. */
export function sharedWorkflowPromotionSpaces(
  versions: readonly WorkflowPromotionVersion[],
  targetVersion: number,
  sourceSpace: string,
  targetSpaces: readonly (string | null)[] = versions.map((row) => row.spaceId),
): WorkflowPromotionSpaceDecision {
  const bySpace = new Map<string | null, WorkflowPromotionVersion[]>()
  for (const spaceId of targetSpaces) bySpace.set(spaceId, [])
  for (const version of versions.filter((row) => bySpace.has(row.spaceId)))
    bySpace.get(version.spaceId)!.push(version)

  const changed: (string | null)[] = [],
    overrides: string[] = [],
    pinned: string[] = []
  for (const [spaceId, rows] of bySpace) {
    const disposition = sharedWorkflowPromotionDisposition(spaceId, versions, sourceSpace)
    if (disposition === 'override') {
      if (spaceId !== null) overrides.push(spaceId)
      continue
    }
    if (disposition === 'pinned') {
      if (spaceId !== null) pinned.push(spaceId)
      continue
    }
    if (!rows.some((row) => row.n === targetVersion && row.status === 'production'))
      changed.push(spaceId)
  }
  return { changed, overrides, pinned }
}
