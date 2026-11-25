// concern: record-identity
/** Classifies a board-message id and optionally resolves its local row. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

export type BoardMessageIdentity =
  | { kind: 'number'; number: number; valid: boolean; row: { record_id: string } | null }
  | { kind: 'record'; recordId: string; row: { record_id: string } | null }
  | { kind: 'invalid'; row: null }

export function boardMessageIdentity(
  database: Database,
  given: string,
  resolveLocal: boolean,
): BoardMessageIdentity {
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    const valid = Number.isSafeInteger(number) && number >= 1
    const row =
      resolveLocal && valid
        ? database
            .query<{ record_id: string }, [number]>(
              'SELECT record_id FROM board_message WHERE number=?',
            )
            .get(number)
        : null
    return { kind: 'number', number, valid, row }
  }
  if (hasRecordIdShape(given)) {
    const recordId = given.toLowerCase()
    const row = resolveLocal
      ? database
          .query<{ record_id: string }, [string]>(
            'SELECT record_id FROM board_message WHERE record_id=?',
          )
          .get(recordId)
      : null
    return { kind: 'record', recordId, row }
  }
  return { kind: 'invalid', row: null }
}
