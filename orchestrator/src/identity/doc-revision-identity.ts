// concern: record-identity
/** Resolves a user-facing document-revision number or UUID at the identity door. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { applyRecordReadAuthority } from '../record/record-read-authority.ts'

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

export async function resolveDocRevisionIdentifier(
  database: Database,
  input: string | number,
): Promise<string> {
  const parsed = parseDocRevisionIdentifier(input)
  return applyRecordReadAuthority(
    {
      local: () => {
        if (parsed.kind === 'number') {
          const row = database
            .query<{ record_id: string }, [number]>(
              'SELECT record_id FROM doc_revision WHERE number=?',
            )
            .get(parsed.number)
          if (row) return row.record_id
          throw new Error(`no document revision has number ${parsed.number}; pass ${ACCEPTED}`)
        }
        if (database.query('SELECT 1 FROM doc_revision WHERE record_id=?').get(parsed.recordId))
          return parsed.recordId
        throw new Error(`no document revision has UUID ${JSON.stringify(input)}; pass ${ACCEPTED}`)
      },
      hosted: () => {
        if (parsed.kind === 'number') {
          throw new Error(
            `hosted document revisions have no numeric identifier; pass the revision id listed by ${PLATFORM_SLUG} doc history`,
          )
        }
        return parsed.recordId
      },
    },
    database,
  )
}
