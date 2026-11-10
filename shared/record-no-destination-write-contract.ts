// concern: record-no-destination-write-contract
/** Defines the hosted destination-less write measurement response. */

export const NO_DESTINATION_WRITES_ROUTE = '/v1/health/no-destination-writes'
export const NO_DESTINATION_WRITE_CAUSE_LENGTH = 200

export function noDestinationWriteCause(userAgent: string | null | undefined): string {
  return (userAgent?.trim() || 'unknown').slice(0, NO_DESTINATION_WRITE_CAUSE_LENGTH)
}

export type NoDestinationWrite = { spaceId: string; route: string; cause: string }

export type NoDestinationWriteReportRow = NoDestinationWrite & { occurrences: number }

export type NoDestinationWriteReport = {
  processStartedAt: string
  counts: ReadonlyArray<NoDestinationWriteReportRow>
}

export function parseNoDestinationWriteReport(
  value: unknown,
  surface: string,
): NoDestinationWriteReport {
  const invalid = () => new Error(`${surface} returned invalid destination-less write counts`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const report = value as Record<string, unknown>
  if (typeof report.processStartedAt !== 'string' || !Array.isArray(report.counts)) throw invalid()
  const counts = report.counts.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
    const row = input as Record<string, unknown>
    if (
      typeof row.spaceId !== 'string' ||
      typeof row.route !== 'string' ||
      typeof row.cause !== 'string' ||
      !Number.isInteger(row.occurrences)
    )
      throw invalid()
    return row as NoDestinationWriteReportRow
  })
  return { processStartedAt: report.processStartedAt, counts }
}
