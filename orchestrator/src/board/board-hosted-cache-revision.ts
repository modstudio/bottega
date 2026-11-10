// concern: hosted-board-read-cache-revision
/** Decides whether an incoming hosted board revision predates the cached revision. */

export function hostedBoardRevisionIsStale(cached: string | null, incoming: string): boolean {
  return cached !== null && BigInt(incoming) < BigInt(cached)
}
