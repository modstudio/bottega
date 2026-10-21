// concern: storage-report command
/** Owns storage-report invocation and presentation. Must not know CLI grammar. */

import { formatStorageReport, storageReport } from './storage-report.ts'

export async function storageCommand(
  json: boolean,
  presentation: { write(value: string): Promise<void> },
): Promise<void> {
  const report = await storageReport()
  await presentation.write(`${json ? JSON.stringify(report) : formatStorageReport(report)}\n`)
}
