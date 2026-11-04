export type IngestReport = {
  examined: number
  rows: number
  skipped: number
  skippedUnlinked?: number
  unreadable?: number
}
