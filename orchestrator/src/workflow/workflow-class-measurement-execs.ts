// concern: workflows
/** Reads class-measurement exec facts: post-implement candidates and the measure exec's cwd. */

import type { Database } from 'bun:sqlite'
import { probeRecordIdForNumber } from './probe-identifier.ts'
import { renderClassMeasurementCommand } from './workflow-class-measured-floor.ts'

export type ClassMeasurementExec = {
  command: string
  cwd: string
  output: string
  exitCode: number
  createdAt: string
}

export function classMeasurementExecCwd(database: Database, execId: number): string | undefined {
  const recordId = probeRecordIdForNumber(database, execId)
  if (!recordId) return undefined
  return database
    .query<{ cwd: string }, [string]>("SELECT cwd FROM probe WHERE kind='exec' AND record_id=?")
    .get(recordId)?.cwd
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
        cwd: string
        output_tail: string
        exit_code: number
        created_at: string
      },
      [string]
    >(
      "SELECT command,command_withheld,cwd,output_tail,exit_code,created_at FROM probe WHERE kind='exec' AND session_id=? ORDER BY created_at DESC",
    )
    .all(session)
    .flatMap((row) => {
      const command = renderClassMeasurementCommand(
        structuredArgv(row.command, row.command_withheld === 1),
      )
      return command
        ? [
            {
              command,
              cwd: row.cwd,
              output: row.output_tail,
              exitCode: row.exit_code,
              createdAt: row.created_at,
            },
          ]
        : []
    })
}
