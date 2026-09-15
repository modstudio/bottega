// concern: keep-tree-hold
/** Knows bounded explicit worktree holds. Must not know databases, cleanup, runs, or the CLI. */

export const DEFAULT_KEEP_TREE_HOURS = 24
export const MAX_KEEP_TREE_HOURS = 72
const HOUR_MS = 60 * 60 * 1000

export type KeepTreeExemption = {
  until: string
  reason: string
}

export type KeepTreeHoldDecision =
  | { held: true; until: string }
  | { held: false; expiredAt: string }
  | { held: false }

export type KeepTreeHoldInput = {
  keepTree: boolean | number
  keepTreeUntil: string | null
  startedAt: string
  now: string
}

/** Parse the optional `--keep-tree` hours value at the command edge. */
export function parseKeepTreeDuration(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KEEP_TREE_HOURS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_KEEP_TREE_HOURS) {
    throw new Error(
      `--keep-tree duration must be a positive number of hours, maximum ${MAX_KEEP_TREE_HOURS}`,
    )
  }
  return hours
}

/** Create the durable exemption recorded at dispatch. */
export function keepTreeExemption(
  hours: number,
  reason: string | undefined,
  now: number = Date.now(),
): KeepTreeExemption {
  return {
    until: new Date(now + hours * HOUR_MS).toISOString(),
    reason: reason?.trim() || 'explicit --keep-tree',
  }
}

/** Parse and materialize the optional command exemption without growing the command adapter. */
export function keepTreeExemptionFromOption(
  enabled: boolean,
  rawHours: string | undefined,
  reason: string | undefined,
  now: number = Date.now(),
): KeepTreeExemption | undefined {
  if (!enabled) return undefined
  return keepTreeExemption(parseKeepTreeDuration(rawHours), reason, now)
}

/** Decide whether a recorded hold still exempts its worktree from release. */
export function keepTreeHold(input: KeepTreeHoldInput): KeepTreeHoldDecision {
  if (!input.keepTree) return { held: false }
  const until =
    input.keepTreeUntil ??
    new Date(Date.parse(input.startedAt) + DEFAULT_KEEP_TREE_HOURS * HOUR_MS).toISOString()
  if (Date.parse(input.now) < Date.parse(until)) return { held: true, until }
  return { held: false, expiredAt: until }
}
