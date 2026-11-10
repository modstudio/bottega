// concern: record-no-destination-write-contract
/** Defines the hosted destination-less write measurement response. */

export const NO_DESTINATION_WRITES_ROUTE = '/v1/health/no-destination-writes'

export type NoDestinationWrite = { spaceId: string; route: string; cause: string }

export type NoDestinationWriteReportRow = NoDestinationWrite & { occurrences: number }

export type NoDestinationWriteReport = {
  processStartedAt: string
  counts: ReadonlyArray<NoDestinationWriteReportRow>
}
