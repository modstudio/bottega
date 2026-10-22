// concern: workflow-shared-promotion
/** Decides which catalogue spaces follow a shared workflow promotion. */

export type WorkflowPromotionVersion = {
  spaceId: string | null
  n: number
  status: 'draft' | 'production' | 'retired'
  author: string
  definition?: string
  reason?: string
}

export type WorkflowPromotionEvent = {
  spaceId: string | null
  event: string
  author: string
  reason: string
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

/** A space owns its history as soon as any version was authored outside the shared seed. */
export function sharedWorkflowPromotionSpaces(
  versions: readonly WorkflowPromotionVersion[],
  targetVersion: number,
  seedAuthor: string,
  events: readonly WorkflowPromotionEvent[],
  targetSpaces: readonly (string | null)[] = versions.map((row) => row.spaceId),
): WorkflowPromotionSpaceDecision {
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
    if (rows.some((row) => row.author !== seedAuthor)) {
      if (spaceId !== null) overrides.push(spaceId)
      continue
    }
    const operatorPin = events.some(
      (event) =>
        event.spaceId === spaceId &&
        event.event === 'promote' &&
        event.author !== seedAuthor &&
        !event.reason.startsWith(SHARED_WORKFLOW_PROMOTION_REASON),
    )
    if (operatorPin) {
      if (spaceId !== null) pinned.push(spaceId)
      continue
    }
    if (!rows.some((row) => row.n === targetVersion && row.status === 'production'))
      changed.push(spaceId)
  }
  return { changed, overrides, pinned }
}
