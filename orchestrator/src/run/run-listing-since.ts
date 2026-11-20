// concern: validates and normalizes run-list time windows.

import { refusal, renderRefusal } from '../../../shared/refusal.ts'

/** Normalize a run-list window to the UTC timestamp form stored in SQLite. */
export function parseRunListSince(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) {
    throw new Error(
      renderRefusal(
        refusal(`invalid --since value: ${JSON.stringify(value)}`, {
          kind: 'edit',
          text: 'provide --since as an ISO 8601 timestamp, for example 2026-11-19T06:02:03.000Z',
        }),
      ),
    )
  }
  return new Date(instant).toISOString()
}
