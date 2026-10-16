/** The rows of one page and where that page sits in the whole list. */
export function pageSlice<T>(rows: readonly T[], page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(Math.max(1, page), pageCount)
  const start = (current - 1) * pageSize
  return {
    rows: rows.slice(start, start + pageSize),
    page: current,
    pageCount,
    first: rows.length ? start + 1 : 0,
    last: Math.min(start + pageSize, rows.length),
    total: rows.length,
  }
}
