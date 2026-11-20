// concern: formats run-concern confinement counts for the sandbox report.

import {
  CONFINEMENT_RUN_WINDOW_DAYS,
  type RunConfinementCounts,
} from '../run/run-confinement-count.ts'

export function formatConfinementRunMeasurement(measurement: RunConfinementCounts): string[] {
  const defaultLabel = measurement.defaultWindow
    ? ` (default ${CONFINEMENT_RUN_WINDOW_DAYS} days)`
    : ''
  return [
    `read-only-run-window  since=${measurement.since}${defaultLabel}`,
    ...measurement.rows.map(
      (row) =>
        `read-only-run-count  sandbox=${row.sandbox}  reason=${JSON.stringify(row.reason)}  count=${row.count}`,
    ),
  ]
}
