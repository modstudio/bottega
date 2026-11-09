// concern: context-stale
/** Pure stale-next-action decision. */

export type ContextWorkEvent = { holder: string; at: string }
export type ContextNextActionRevision = { holder: string; at: string }
export type StaleContextHolder = { holder: string; workedAt: string; revisedAt: string | null }

export function staleContextHolders(
  work: readonly ContextWorkEvent[],
  revisions: readonly ContextNextActionRevision[],
): StaleContextHolder[] {
  const latestWork = new Map<string, string>()
  for (const event of work) {
    const prior = latestWork.get(event.holder)
    if (!prior || event.at > prior) latestWork.set(event.holder, event.at)
  }
  const latestRevision = new Map<string, string>()
  for (const revision of revisions) {
    const prior = latestRevision.get(revision.holder)
    if (!prior || revision.at > prior) latestRevision.set(revision.holder, revision.at)
  }
  return [...latestWork]
    .filter(([holder, workedAt]) => workedAt > (latestRevision.get(holder) ?? ''))
    .map(([holder, workedAt]) => ({
      holder,
      workedAt,
      revisedAt: latestRevision.get(holder) ?? null,
    }))
    .sort((a, b) => a.holder.localeCompare(b.holder))
}
