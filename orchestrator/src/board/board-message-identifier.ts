// concern: board-identity
/** Resolves a human-facing board-message number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { boardModeForId } from './board-mode.ts'

const ACCEPTED = 'a positive decimal board-message number or a full board-message UUID'

export type BoardIdentifierResolution = {
  source: 'local' | 'hosted'
  recordId: string
}

type Environment = Record<string, string | undefined>

function uploadedShadow(database: Database, recordId: string, kind: 'message' | 'claim'): boolean {
  const row = database
    .query<{ state: 'pending' | 'uploaded' | 'refused' }, [string, string]>(
      `SELECT state FROM board_hosted_adoption_ledger
       WHERE source_record_id=? AND local_kind ${kind === 'claim' ? '=' : '<>'} ?`,
    )
    .get(recordId, 'claim')
  return row?.state === 'uploaded'
}

function hosted(
  database: Database,
  recordId: string,
  noun: string,
  environment: Environment,
  validateHosted: boolean,
): BoardIdentifierResolution {
  if (validateHosted) boardModeForId(recordId, noun, environment, database)
  return { source: 'hosted', recordId }
}

export function resolveBoardMessageIdentifier(
  database: Database,
  input: string | number,
  environment: Environment = process.env,
  validateHosted = true,
): BoardIdentifierResolution {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error(
        `invalid board-message identifier ${JSON.stringify(given)}: expected ${ACCEPTED}`,
      )
    const row = database
      .query<{ record_id: string }, [number]>('SELECT record_id FROM board_message WHERE number=?')
      .get(number)
    if (row) return { source: 'local', recordId: row.record_id }
    throw new Error(`no board message has number ${number}; pass ${ACCEPTED}`)
  }
  if (!hasRecordIdShape(given))
    throw new Error(
      `invalid board-message identifier ${JSON.stringify(given)}: expected ${ACCEPTED}`,
    )
  const recordId = given.toLowerCase()
  const row = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM board_message WHERE record_id=?')
    .get(recordId)
  if (uploadedShadow(database, recordId, 'message'))
    return hosted(database, recordId, 'board message identifier', environment, validateHosted)
  if (row) return { source: 'local', recordId: row.record_id }
  return hosted(database, recordId, 'board message identifier', environment, validateHosted)
}

export function resolveBoardClaimIdentifier(
  database: Database,
  input: string,
  environment: Environment = process.env,
  validateHosted = true,
): BoardIdentifierResolution {
  if (!hasRecordIdShape(input))
    throw new Error(
      `invalid board claim identifier ${JSON.stringify(input)}: expected a full board claim UUID`,
    )
  const recordId = input.toLowerCase()
  const row = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM board_claim WHERE record_id=?')
    .get(recordId)
  if (uploadedShadow(database, recordId, 'claim'))
    return hosted(database, recordId, 'board claim UUID', environment, validateHosted)
  if (row) return { source: 'local', recordId: row.record_id }
  return hosted(database, recordId, 'board claim UUID', environment, validateHosted)
}

export function resolveLocalBoardMessageIdentifier(
  database: Database,
  input: string | number,
  environment: Environment = process.env,
): string {
  const resolved = resolveBoardMessageIdentifier(database, input, environment)
  if (resolved.source === 'hosted')
    throw new Error(`board message ${JSON.stringify(String(input))} is hosted, not a local row`)
  return resolved.recordId
}

export function resolveBoardDeliveryIdentifier(
  database: Database,
  input: string | number,
  environment: Environment = process.env,
): BoardIdentifierResolution | null {
  try {
    return resolveBoardMessageIdentifier(database, input, environment, false)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid board-message identifier '))
      return null
    throw error
  }
}
