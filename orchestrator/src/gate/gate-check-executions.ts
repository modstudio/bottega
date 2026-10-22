// concern: worker gate
/** Shared capture and persistence for machine-readable checks emitted by a gate. */

import type { Database } from 'bun:sqlite'
import { readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CheckExecutionRecord,
  parseCheckExecutionLines,
} from '../../../shared/check-execution.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'

export function gateCheckExecutionPath(directory?: string): string {
  return join(
    directory ?? dirname(resolveOrchestratorDatabase(process.env)),
    `check-execution-${crypto.randomUUID()}.jsonl`,
  )
}

export function readGateCheckExecutions(
  path: string,
  write: (chunk: string) => void,
): CheckExecutionRecord[] {
  let records: CheckExecutionRecord[] = []
  try {
    const parsed = parseCheckExecutionLines(readFileSync(path, 'utf8'))
    records = parsed.records
    if (parsed.rejected) write(`check execution records rejected ${parsed.rejected} line(s)\n`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      write(`check execution records could not be read: ${String(error)}\n`)
    }
  } finally {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        write(`check execution records could not be removed: ${String(error)}\n`)
      }
    }
  }
  return records
}

export function insertGateCheckExecutions(
  database: Database,
  gateExecutionId: number,
  records: readonly CheckExecutionRecord[],
): void {
  const insert = database.query(
    `INSERT INTO check_execution
      (record_id,gate_execution_id,check_name,category,wall_ms,cpu_ms,exit_code,remaining_count)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
  for (const check of records) {
    insert.run(
      newRecordId(),
      gateExecutionId,
      check.check,
      check.category ?? null,
      check.wallMs,
      check.cpuMs ?? null,
      check.exitCode,
      check.remaining ?? null,
    )
  }
}
