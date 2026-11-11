// concern: removal-report
/** Ordered row counts returned and rendered by destructive operations. */
export type RemovalReport = Array<{ table: string; count: number }>

export function renderRemovalReport(report: RemovalReport, log: (value: string) => void): void {
  for (const { table, count } of report) if (count > 0) log(`removed\t${table}\t${count}`)
}
