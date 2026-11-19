// concern: record-cache-counts-contract
/** Wire contract for hosted rows that can populate a machine's local document cache. */

export const RECORD_CACHE_COUNTS_BY_SCOPE = 'scope'

export type RecordCacheCounts = {
  byScope: Array<{ scope: string; project: string | null; docs: number }>
  subjectsByProject: Array<{ project: string; subjects: number }>
}
