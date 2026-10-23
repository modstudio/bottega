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

export type WorkflowPromotionSpaceDecision = {
  changed: (string | null)[]
  overrides: string[]
  pinned: string[]
}

export type WorkflowPromotionReport = {
  version: number
  changedSpaces: string[]
  overrideSpaces: string[]
  pinnedSpaces: string[]
}

export const workflowPromotionReport = (
  version: number,
  decision: WorkflowPromotionSpaceDecision,
): WorkflowPromotionReport => ({
  version,
  changedSpaces: decision.changed.map((spaceId) => spaceId ?? 'local'),
  overrideSpaces: decision.overrides,
  pinnedSpaces: decision.pinned,
})

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

/** A space follows while every version it holds matches the source history. */
export function sharedWorkflowPromotionSpaces(
  versions: readonly WorkflowPromotionVersion[],
  targetVersion: number,
  sourceSpace: string,
  targetSpaces: readonly (string | null)[] = versions.map((row) => row.spaceId),
): WorkflowPromotionSpaceDecision {
  const sourceVersions = new Map(
    versions.filter((row) => row.spaceId === sourceSpace).map((row) => [row.n, row.definition]),
  )
  const bySpace = new Map<string | null, WorkflowPromotionVersion[]>()
  for (const spaceId of targetSpaces) bySpace.set(spaceId, [])
  for (const version of versions) {
    const rows = bySpace.get(version.spaceId) ?? []
    rows.push(version)
    bySpace.set(version.spaceId, rows)
  }

  const changed: (string | null)[] = [],
    overrides: string[] = [],
    pinned: string[] = []
  for (const [spaceId, rows] of bySpace) {
    if (rows.some((row) => sourceVersions.get(row.n) !== row.definition)) {
      if (spaceId !== null) overrides.push(spaceId)
      continue
    }
    if (pinsSharedPromotion(spaceId, sourceSpace, rows)) {
      if (spaceId !== null) pinned.push(spaceId)
      continue
    }
    if (!rows.some((row) => row.n === targetVersion && row.status === 'production'))
      changed.push(spaceId)
  }
  return { changed, overrides, pinned }
}
