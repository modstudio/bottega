// concern: workflows
/** Reads workflow exec facts used to verify a post-implement class measurement. */

import type { Database } from 'bun:sqlite'
import { renderClassMeasurementCommand } from './workflow-class-measured-floor.ts'

export type ClassMeasurementExec = {
  command: string
  output: string
  exitCode: number
  createdAt: string
}

function structuredArgv(raw: string, withheld: boolean): string[] | null {
  if (withheld) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string') ? parsed : null
  } catch {
    return null
  }
}

export function classMeasurementExecsForSession(
  database: Database,
  session: string,
): ClassMeasurementExec[] {
  return database
    .query<
      {
        command: string
        command_withheld: number
        output_tail: string
        exit_code: number
        created_at: string
      },
      [string]
    >(
      "SELECT command,command_withheld,output_tail,exit_code,created_at FROM probe WHERE kind='exec' AND session_id=? ORDER BY created_at DESC",
    )
    .all(session)
    .flatMap((row) => {
      const command = renderClassMeasurementCommand(
        structuredArgv(row.command, row.command_withheld === 1),
      )
      return command
        ? [{ command, output: row.output_tail, exitCode: row.exit_code, createdAt: row.created_at }]
        : []
    })
}
