// concern: monitor
/** Summarizes current canon findings for a monitor pass. */

import { allInjectChecks } from '../canon/canon.ts'

export function monitorCanonSummary(): { findings: number; docs: number } {
  const rows = allInjectChecks()
  return {
    findings: rows.reduce(
      (count, row) => count + row.findings.filter((finding) => finding.kind !== 'unchecked').length,
      0,
    ),
    docs: rows.filter((row) => row.findings.some((finding) => finding.kind !== 'unchecked')).length,
  }
}
