// concern: record-cache-counts-contract
/** Wire contract for hosted rows that can populate a machine's local document cache. */

export const RECORD_CACHE_COUNTS_BY_SCOPE = 'scope'

export type RecordCacheCounts = {
  byScope: Array<{ scope: string; project: string | null; docs: number }>
  subjectsByProject: Array<{ project: string; subjects: number }>
}

export function isRecordCacheCounts(value: unknown): value is RecordCacheCounts {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<RecordCacheCounts>
  return (
    Array.isArray(response.byScope) &&
    response.byScope.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.scope === 'string' &&
        (row.project === null || typeof row.project === 'string') &&
        typeof row.docs === 'number' &&
        Number.isFinite(row.docs),
    ) &&
    Array.isArray(response.subjectsByProject) &&
    response.subjectsByProject.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.project === 'string' &&
        typeof row.subjects === 'number' &&
        Number.isFinite(row.subjects),
    )
  )
}
