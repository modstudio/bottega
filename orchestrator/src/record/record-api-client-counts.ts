// concern: record-api-client-counts
/** HTTP transport for hosted record count measurements. */

import type { RecordClientRequest, RecordRequestDestination } from './record-api-client-paths.ts'
import type { RecordCacheCounts } from './record-cache-counts.ts'

type BaseCounts = { docs: number; revisions: number; scores: number; voids: number }

export type RecordCountsClient = {
  counts(destination?: RecordRequestDestination): Promise<BaseCounts>
  cacheCounts(destination: RecordRequestDestination): Promise<BaseCounts & RecordCacheCounts>
}

export const recordCountsClient = (request: RecordClientRequest): RecordCountsClient => ({
  counts: (destination) => request('/v1/docs/counts', destination),
  cacheCounts: (destination) => request('/v1/docs/counts?by=scope', destination),
})
