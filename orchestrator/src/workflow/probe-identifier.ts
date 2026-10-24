// concern: workflow floor evidence
/** Resolves a user-facing probe number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

type ParsedProbeIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_PROBE_IDENTIFIERS = 'a positive decimal probe number or a full probe UUID'

function parseProbeIdentifier(input: string | number): ParsedProbeIdentifier {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid probe identifier ${JSON.stringify(given)}: expected ${ACCEPTED_PROBE_IDENTIFIERS}`,
  )
}

export function resolveProbeIdentifier(database: Database, input: string | number): string {
  const parsed = parseProbeIdentifier(input)
  if (parsed.kind === 'number') {
    const row = database
      .query<{ record_id: string }, [number]>('SELECT record_id FROM probe WHERE number=?')
      .get(parsed.number)
    if (row) return row.record_id
    throw new Error(`no probe has number ${parsed.number}; pass ${ACCEPTED_PROBE_IDENTIFIERS}`)
  }
  const row = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM probe WHERE record_id=?')
    .get(parsed.recordId)
  if (row) return row.record_id
  throw new Error(
    `no probe has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_PROBE_IDENTIFIERS}`,
  )
}

export function resolveProbeArtifact(
  database: Database,
  artifact: string | undefined,
): string | undefined {
  if (artifact === undefined) return undefined
  const parsed = /^(probe|exec):(.+)$/i.exec(artifact.trim())
  if (!parsed) return artifact
  return `${parsed[1]!.toLowerCase()}:${resolveProbeIdentifier(database, parsed[2]!)}`
}
