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

type SharedWorkflowPromotionInput = {
  slug: string
  targetVersion: number
  sourceSpace: string
  seedAuthor: string
  versions: readonly WorkflowPromotionVersion[]
  draftVersion(spaceId: string | null, version: WorkflowPromotionVersion): Promise<number>
  promoteSpace(spaceId: string | null): Promise<void>
}

export async function promoteSharedWorkflowSpaces(
  input: SharedWorkflowPromotionInput,
): Promise<WorkflowPromotionSpaceDecision> {
  const decision = sharedWorkflowPromotionSpaces(
    input.versions,
    input.targetVersion,
    input.seedAuthor,
  )
  const source = input.versions.filter(
    (row) => row.spaceId === input.sourceSpace && row.n <= input.targetVersion,
  )
  for (const spaceId of decision.changed) {
    const present = new Set(
      input.versions.filter((row) => row.spaceId === spaceId).map((row) => row.n),
    )
    for (const version of source.filter((row) => !present.has(row.n))) {
      const written = await input.draftVersion(spaceId, version)
      if (written !== version.n)
        throw new Error(
          `refusing shared workflow promotion for "${input.slug}": space ${spaceId ?? 'local'} wrote version ${written} while copying version ${version.n}; refresh and retry`,
        )
    }
    await input.promoteSpace(spaceId)
  }
  return decision
}

export type WorkflowPromotionSpaceDecision = {
  changed: (string | null)[]
  overrides: string[]
}

export const workflowPromotionReport = (
  version: number,
  decision: WorkflowPromotionSpaceDecision,
) => ({
  version,
  changedSpaces: decision.changed.map((spaceId) => spaceId ?? 'local'),
  overrideSpaces: decision.overrides,
})

/** A space owns its history as soon as any version was authored outside the shared seed. */
export function sharedWorkflowPromotionSpaces(
  versions: readonly WorkflowPromotionVersion[],
  targetVersion: number,
  seedAuthor: string,
): WorkflowPromotionSpaceDecision {
  const bySpace = new Map<string | null, WorkflowPromotionVersion[]>()
  for (const version of versions) {
    const rows = bySpace.get(version.spaceId) ?? []
    rows.push(version)
    bySpace.set(version.spaceId, rows)
  }

  const changed: (string | null)[] = [],
    overrides: string[] = []
  for (const [spaceId, rows] of bySpace) {
    if (rows.some((row) => row.author !== seedAuthor)) {
      if (spaceId !== null) overrides.push(spaceId)
      continue
    }
    if (!rows.some((row) => row.n === targetVersion && row.status === 'production'))
      changed.push(spaceId)
  }
  return { changed, overrides }
}
