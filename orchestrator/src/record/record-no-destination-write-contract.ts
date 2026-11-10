// concern: record-no-destination-write-contract
/** Defines the hosted destination-less write measurement response. */

import type { NoDestinationWrite } from './record-no-destination-write-decision.ts'

export type NoDestinationWriteReportRow = NoDestinationWrite & { occurrences: number }

export type NoDestinationWriteReport = {
  processStartedAt: string
  counts: ReadonlyArray<NoDestinationWriteReportRow>
}
