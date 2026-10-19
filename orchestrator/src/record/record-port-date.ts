// concern: record-port-date
/** Normalizes legacy date-only port baseline timestamps at hosted import boundaries. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function normalizePortBaselineScannedAt(value: string | null): string | null {
  return value !== null && DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value
}
