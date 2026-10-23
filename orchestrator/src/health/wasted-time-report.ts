// concern: wasted-time efficiency report
/** Reuses health failure classification over an explicitly bounded run window. */

import type { Database } from 'bun:sqlite'
import { HEALTH_CLASSES, type HealthRunRow, healthClassTotals } from './health.ts'

export type WastedTimeWindow = { start: string; end: string }

export function wastedTimeReport(rows: readonly HealthRunRow[], window: WastedTimeWindow) {
  return {
    window,
    classes: healthClassTotals(rows, HEALTH_CLASSES),
  }
}

export function loadWastedTimeReport(
  database: Database,
  windows: { currentWindow: WastedTimeWindow; previousWindow: WastedTimeWindow },
  project?: string,
) {
  const rows = database
    .query(
      `SELECT r.record_id,r.number,r.started_at,r.latency_ms,r.failure_kind,r.status,r.error,
              r.work_preserved
         FROM run r LEFT JOIN project p ON p.record_id=r.project_record_id
        WHERE r.started_at>=? AND r.started_at<? AND (? IS NULL OR p.name=?)
        ORDER BY r.started_at,r.number`,
    )
    .all(
      windows.previousWindow.start,
      windows.currentWindow.end,
      project ?? null,
      project ?? null,
    ) as HealthRunRow[]
  const inWindow = (row: HealthRunRow, window: WastedTimeWindow) =>
    row.started_at >= window.start && row.started_at < window.end
  return {
    current: wastedTimeReport(
      rows.filter((row) => inWindow(row, windows.currentWindow)),
      windows.currentWindow,
    ),
    previous: wastedTimeReport(
      rows.filter((row) => inWindow(row, windows.previousWindow)),
      windows.previousWindow,
    ),
  }
}
