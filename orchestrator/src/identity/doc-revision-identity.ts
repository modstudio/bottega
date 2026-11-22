// concern: record-identity
/** Resolves a user-facing document-revision number or UUID at the identity door. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordApiConfigured } from '../../../shared/record-api-url.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { docRevisionRecordExists, docRevisionRecordId } from '../database/entity-number.ts'

const ACCEPTED = 'a positive decimal document-revision number or a full document-revision UUID'

export type ParsedDocRevisionIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

export function parseDocRevisionIdentifier(input: string | number): ParsedDocRevisionIdentifier {
  const given = String(input)
  const number = /^[0-9]+$/.test(given) ? Number(given) : null
  if (number !== null && Number.isSafeInteger(number) && number > 0) {
    return { kind: 'number', number }
  }
  if (!hasRecordIdShape(given))
    throw new Error(
      `invalid document-revision identifier ${JSON.stringify(given)}: expected ${ACCEPTED}`,
    )
  return { kind: 'record-id', recordId: given.toLowerCase() }
}

export function resolveDocRevisionIdentifier(database: Database, input: string | number): string {
  const parsed = parseDocRevisionIdentifier(input)
  if (recordApiConfigured()) {
    if (parsed.kind === 'number') {
      throw new Error(
        `hosted document revisions have no numeric identifier; pass the revision id listed by ${PLATFORM_SLUG} doc history`,
      )
    }
    return parsed.recordId
  }
  if (parsed.kind === 'number') {
    const recordId = docRevisionRecordId(database, parsed.number)
    if (recordId) return recordId
    throw new Error(`no document revision has number ${parsed.number}; pass ${ACCEPTED}`)
  }
  if (docRevisionRecordExists(database, parsed.recordId)) return parsed.recordId
  throw new Error(`no document revision has UUID ${JSON.stringify(input)}; pass ${ACCEPTED}`)
}
