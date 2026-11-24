// concern: workflows
/** Reads workflow exec facts used to verify a post-implement class measurement. */

import type { Database } from 'bun:sqlite'

export type ClassMeasurementExec = {
  command: string
  output: string
  exitCode: number
  createdAt: string
}

export function classMeasurementExecsForSession(
  database: Database,
  session: string,
): ClassMeasurementExec[] {
  return database
    .query<
      { command: string; output_tail: string; exit_code: number; created_at: string },
      [string]
    >(
      "SELECT command,output_tail,exit_code,created_at FROM probe WHERE kind='exec' AND session_id=? ORDER BY created_at DESC",
    )
    .all(session)
    .map((row) => ({
      command: recordedCommand(row.command),
      output: row.output_tail,
      exitCode: row.exit_code,
      createdAt: row.created_at,
    }))
}

function recordedCommand(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value) && value.every((part) => typeof part === 'string'))
      return value.join(' ')
  } catch {
    // Legacy command records are already text.
  }
  return raw
}
