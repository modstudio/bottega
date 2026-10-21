// concern: reclaim kind registry
/** Canonical names accepted and advertised by `machine reclaim`. */

export const RECLAIM_KINDS = [
  'worktree',
  'branch',
  'orphan-process',
  'orphan-docker-volume',
  'ref-guard',
  'sandbox',
  'retained-ref',
  'trust',
  'process',
  'stale-run',
  'fixture-questions',
] as const

export type ReclaimKind = (typeof RECLAIM_KINDS)[number]
export const RECLAIM_KIND_SET: ReadonlySet<string> = new Set(RECLAIM_KINDS)
