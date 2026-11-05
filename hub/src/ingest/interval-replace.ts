export type IntervalNaturalKey = {
  source: string
  ref: string
  start_at: string
}

export type ExistingIntervalRow = IntervalNaturalKey & { record_id: string }

export type CollectorReplaceDecision<T extends IntervalNaturalKey> = {
  updates: Array<T & { record_id: string }>
  inserts: T[]
  deletes: string[]
  unchanged: number
}

function naturalKey(row: IntervalNaturalKey): string {
  return JSON.stringify([row.source, row.ref, row.start_at])
}

/** Match recomputed rows to existing ones by (source, ref, start_at). */
export function decideCollectorReplace<
  T extends IntervalNaturalKey,
  E extends ExistingIntervalRow = ExistingIntervalRow,
>(
  existing: readonly E[],
  recomputed: readonly T[],
  preservedRefs: ReadonlySet<string> = new Set(),
  equal: (existing: E, recomputed: T) => boolean = () => false,
): CollectorReplaceDecision<T> {
  const byKey = new Map(existing.map((row) => [naturalKey(row), row]))
  const recomputedKeys = new Set(recomputed.map(naturalKey))
  const updates: Array<T & { record_id: string }> = []
  const inserts: T[] = []
  let unchanged = 0
  for (const row of recomputed) {
    const prior = byKey.get(naturalKey(row))
    if (prior && equal(prior, row)) unchanged++
    else if (prior) updates.push({ ...row, record_id: prior.record_id })
    else inserts.push(row)
  }
  return {
    updates,
    inserts,
    unchanged,
    deletes: existing
      .filter((row) => !preservedRefs.has(row.ref) && !recomputedKeys.has(naturalKey(row)))
      .map((row) => row.record_id),
  }
}
