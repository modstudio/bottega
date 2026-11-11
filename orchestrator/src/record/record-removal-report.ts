// concern: record-removal-report
/** Ordered row counts returned and rendered by hosted destructive operations. */
export type RecordRemovalReport = Array<{ table: string; count: number }>

export function renderRecordRemovalReport(
  report: RecordRemovalReport,
  log: (value: string) => void,
): void {
  for (const { table, count } of report) {
    if (count > 0) log(`removed\t${table}\t${count}`)
  }
}
