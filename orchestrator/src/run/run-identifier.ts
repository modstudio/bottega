// concern: run-control
/** Resolves a user-facing run number or UUID to this machine's local row id. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

export type ParsedRunIdentifier =
  | { kind: 'number'; id: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_RUN_IDENTIFIERS = 'a positive decimal run number or a full run UUID'

export function classifyRunIdentifier(input: string | number): ParsedRunIdentifier | null {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const id = Number(given)
    if (Number.isSafeInteger(id) && id > 0) return { kind: 'number', id }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  return null
}

export function parseRunIdentifier(input: string | number): ParsedRunIdentifier {
  const given = String(input)
  const parsed = classifyRunIdentifier(input)
  if (parsed) return parsed
  throw new Error(
    `invalid run identifier ${JSON.stringify(given)}: expected ${ACCEPTED_RUN_IDENTIFIERS}`,
  )
}

export function resolveRunIdentifier(database: Database, input: string | number): number {
  const parsed = parseRunIdentifier(input)
  if (parsed.kind === 'number') return parsed.id
  const row = database
    .query<{ id: number }, [string]>('SELECT id FROM run WHERE record_id=?')
    .get(parsed.recordId)
  if (row) return row.id
  throw new Error(
    `no run has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_RUN_IDENTIFIERS}`,
  )
}

export function resolveRunIdentifierOrNull(
  database: Database,
  input: string | number,
): number | null {
  const parsed = classifyRunIdentifier(input)
  if (!parsed) return null
  if (parsed.kind === 'number')
    return (
      database.query<{ id: number }, [number]>('SELECT id FROM run WHERE id=?').get(parsed.id)
        ?.id ?? null
    )
  return (
    database
      .query<{ id: number }, [string]>('SELECT id FROM run WHERE record_id=?')
      .get(parsed.recordId)?.id ?? null
  )
}

export function runRecordId(database: Database, id: number): string {
  const row = database
    .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
    .get(id)
  if (!row) throw new Error(`no run ${id}`)
  return row.record_id
}

export function runRecordIdOrNull(database: Database, id: number): string | null {
  return (
    database.query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?').get(id)
      ?.record_id ?? null
  )
}
