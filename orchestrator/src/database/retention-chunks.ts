// concern: bounded retention work
/** Drains bounded delete chunks without making each retention owner repeat the loop policy. */

export function drainRetentionChunks<Row, Total>(options: {
  limit: number
  timeBoundMs?: number
  initial: Total
  select(limit: number): Row[]
  remove(rows: readonly Row[]): void
  accumulate(total: Total, rows: readonly Row[]): Total
}): { total: Total; more: boolean } {
  const started = performance.now()
  let total = options.initial
  let more = false
  do {
    const selected = options.select(options.limit)
    if (selected.length) options.remove(selected)
    total = options.accumulate(total, selected)
    more = selected.length === options.limit
  } while (
    more &&
    (options.timeBoundMs === undefined || performance.now() - started < options.timeBoundMs)
  )
  return { total, more }
}
