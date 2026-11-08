// concern: hosted-call-outcome
/** Stores machine-local hosted-call evidence; read-only commands and best-effort failures record nothing. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record-id.ts'
import { writableDb } from './database/db.ts'

export const HOSTED_CALL_OUTCOME_KEEP_MS = 24 * 60 * 60_000

export type HostedTransportError = 'timeout' | 'refused' | 'dns' | 'reset' | 'other'
export type HostedCallOutcome = {
  observedAt: string
  routeClass: string
  httpStatus: number | null
  transportError: HostedTransportError | null
  latencyMs: number
}
export type HostedCallOutcomeRecorder = (outcome: HostedCallOutcome) => void | Promise<void>

export function classifyHostedTransportError(error: unknown): HostedTransportError {
  const value = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
  const cause = value?.cause as { code?: unknown } | undefined
  const code = String(value?.code ?? cause?.code ?? '').toUpperCase()
  const name = String(value?.name ?? '').toLowerCase()
  const message = String(value?.message ?? error ?? '').toLowerCase()
  if (name.includes('timeout') || message.includes('timeout') || message.includes('timed out'))
    return 'timeout'
  if (code === 'ECONNREFUSED' || message.includes('connection refused')) return 'refused'
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    message.includes('dns') ||
    message.includes('name resolution')
  )
    return 'dns'
  if (code === 'ECONNRESET' || message.includes('connection reset')) return 'reset'
  return 'other'
}

export function recordHostedCallOutcome(
  outcome: HostedCallOutcome,
  database: Database = writableDb(),
): void {
  database
    .query(
      `INSERT INTO hosted_call_outcome
       (record_id,observed_at,route_class,http_status,transport_error,latency_ms)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      outcome.observedAt,
      outcome.routeClass,
      outcome.httpStatus,
      outcome.transportError,
      Math.max(0, Math.round(outcome.latencyMs)),
    )
}

export function pruneHostedCallOutcomes(
  database: Database,
  now = Date.now(),
  dryRun = false,
): { rows: number } {
  const cutoff = new Date(now - HOSTED_CALL_OUTCOME_KEEP_MS).toISOString()
  if (dryRun) {
    const row = database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) count FROM hosted_call_outcome WHERE observed_at<?',
      )
      .get(cutoff)
    return { rows: row?.count ?? 0 }
  }
  const result = database.query('DELETE FROM hosted_call_outcome WHERE observed_at<?').run(cutoff)
  return { rows: result.changes }
}
