// concern: composite storage report
/** Joins owner measurements with the one lifecycle catalogue and formats the front-door report. */

import type { TableStorageReport } from '../shared/storage-lifecycle.ts'

export function formatCompositeStorageReport(report: TableStorageReport): string {
  const lines = ['store table bytes rows class remover-or-slice']
  for (const table of report.tables)
    lines.push(
      `${table.store} ${table.table} ${table.bytes} ${table.rows} ${table.class} ${table.remover ?? `owed:${table.slice}`}` +
        (table.nTupUpd === undefined ? '' : ` updates:${table.nTupUpd} dead:${table.nDeadTup}`),
    )
  for (const missing of report.missing) lines.push(`${missing.store} missing: ${missing.reason}`)
  for (const table of report.undeclared)
    lines.push(
      `${table.store}.${table.table} ${table.bytes} bytes undeclared: no lifecycle declaration for this live table; update the binary or declare it`,
    )
  lines.push('owed removers:')
  for (const finding of report.findings) {
    lines.push(`  ${finding.slice}:`)
    for (const table of finding.tables)
      lines.push(`    ${table.store}.${table.table} ${table.bytes} bytes`)
  }
  lines.push('deliberately kept:')
  for (const table of report.kept)
    lines.push(`  ${table.store}.${table.table} ${table.bytes} bytes`)
  return lines.join('\n')
}
