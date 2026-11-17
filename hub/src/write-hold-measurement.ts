import type { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendStoreWriteHold } from '../../shared/store-write-hold-log.ts'
import { writeCallerFromStack } from '../../shared/write-caller-from-stack.ts'
import {
  finishWriteTransaction,
  WRITE_HOLD_LOG_MS,
  type WriteHoldWindow,
  writeTransactionNeedsCaller,
} from './write-hold.ts'

const measurementSourcePath = fileURLToPath(import.meta.url)
const dbSourcePath = join(dirname(measurementSourcePath), 'db.ts')
const writeHoldWindows = new WeakMap<Database, WriteHoldWindow>()

function databasePath(conn: Database): string {
  const databases = conn.query<{ name: string; file: string }, []>('PRAGMA database_list').all()
  return databases.find((database) => database.name === 'main')?.file || ':memory:'
}

function writeCaller(): string | null {
  return writeCallerFromStack(new Error().stack ?? '', {
    excludedFiles: [measurementSourcePath, dbSourcePath],
  })
}

function appendWindow(conn: Database, window: WriteHoldWindow): void {
  if (window.endedMs - window.beganMs < WRITE_HOLD_LOG_MS) return
  appendStoreWriteHold({
    at: new Date(window.endedMs).toISOString(),
    store: databasePath(conn),
    spanMs: window.endedMs - window.beganMs,
    longestMs: window.longestMs,
    transactions: window.transactions,
    caller: window.caller ?? 'unknown',
  })
}

type FinishedWriteMeasurement = {
  caller?: string
  close?: boolean
}

/** Record a completed write-lock hold without allowing measurement to affect the write. */
export function measureFinishedWrite(
  conn: Database,
  beganMs: number,
  endedMs: number,
  options: FinishedWriteMeasurement = {},
): void {
  try {
    const current = writeHoldWindows.get(conn) ?? null
    const durationMs = endedMs - beganMs
    const caller =
      options.caller ??
      (writeTransactionNeedsCaller(current, beganMs, durationMs) ? writeCaller() : null)
    const measured = finishWriteTransaction(current, { beganMs, endedMs, caller })
    if (measured.closed) appendWindow(conn, measured.closed)
    if (options.close) {
      appendWindow(conn, measured.state)
      writeHoldWindows.delete(conn)
    } else writeHoldWindows.set(conn, measured.state)
  } catch {
    // Measurement must never change the transaction's result or error.
  }
}

export function forgetWriteHoldMeasurement(conn: Database): void {
  writeHoldWindows.delete(conn)
}
