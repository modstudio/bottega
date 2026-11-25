// concern: board-identity
/** Resolves a human-facing board-message number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { BOARD_READ_REFRESH_BUDGET_MS, refreshHostedBoard } from './board-hosted-cache.ts'
import { cachedHostedBoardMessageKind } from './board-hosted-cache-readers.ts'
import {
  HOSTED_BOARD_PRODUCT_STOPPED_REMEDY,
  hostedBoardStoppedMessage,
} from './board-hosted-refresh-message.ts'
import { boardHasAdoptedHosted, boardMode, boardModeForId } from './board-mode.ts'
import { machineMessageRows } from './board-store.ts'

const ACCEPTED = 'a positive decimal board-message number or a full board-message UUID'
const HOSTED_MESSAGE_ID_REMEDY = `pass the board-message record id (UUID); use ${PLATFORM_SLUG} board thread or a board read verb to find it`

export const hostedBoardMessageNotFoundMessage = (recordId: string): string =>
  `board message ${recordId} is not on the hosted board; find the hosted message id with ${PLATFORM_SLUG} board thread or a board read verb`

export type BoardIdentifierResolution = {
  source: 'local' | 'hosted'
  recordId: string
}

type Environment = Record<string, string | undefined>
export type BoardIdentifierRefresh = typeof refreshHostedBoard

export async function refreshHostedBoardIdentifier(
  database: Database,
  environment: Environment,
  refresh: BoardIdentifierRefresh = refreshHostedBoard,
): Promise<void> {
  const refreshed = await refresh({
    budgetMs: BOARD_READ_REFRESH_BUDGET_MS,
    env: environment,
    database,
  })
  if (refreshed.status !== 'success')
    throw new Error(
      hostedBoardStoppedMessage('message read', refreshed, HOSTED_BOARD_PRODUCT_STOPPED_REMEDY),
    )
}

export function boardMessageKind(
  database: Database,
  recordId: string,
  source: 'local' | 'hosted',
): 'root' | 'reply' | 'missing' {
  if (source === 'hosted') return cachedHostedBoardMessageKind(recordId, database)
  const row = database
    .query<{ thread_root_record_id: string | null }, [string]>(
      `SELECT thread_root_record_id FROM board_message WHERE record_id=? LIMIT 1`,
    )
    .get(recordId)
  if (!row) return 'missing'
  return row.thread_root_record_id === null ? 'root' : 'reply'
}

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

function hostedMessageResolution(given: string): BoardIdentifierResolution {
  if (/^[0-9]+$/.test(given))
    throw new Error(`board message number ${given} is local-only; ${HOSTED_MESSAGE_ID_REMEDY}`)
  if (!hasRecordIdShape(given))
    throw new Error(
      `invalid board-message identifier ${JSON.stringify(given)}: expected ${ACCEPTED}`,
    )
  return { source: 'hosted', recordId: given.toLowerCase() }
}

function boardIdentifierMode(
  database: Database,
  environment: Environment,
  validateHosted: boolean,
): 'local' | 'hosted' {
  return validateHosted
    ? boardMode('shared', environment, database)
    : boardHasAdoptedHosted(database)
      ? 'hosted'
      : 'local'
}

export function resolveBoardMessageIdentifier(
  database: Database,
  input: string | number,
  environment: Environment = process.env,
  validateHosted = true,
  allowLocalMachineScoped = false,
): BoardIdentifierResolution {
  const given = String(input)
  const mode = boardIdentifierMode(database, environment, validateHosted)
  if (mode === 'hosted') {
    if (allowLocalMachineScoped) {
      const rows = machineMessageRows(database)
      if (/^[0-9]+$/.test(given)) {
        const number = Number(given)
        const row = Number.isSafeInteger(number)
          ? rows.find((candidate) => candidate.number === number)
          : undefined
        if (row) return { source: 'local', recordId: row.record_id }
      } else if (hasRecordIdShape(given)) {
        const recordId = given.toLowerCase()
        const row = rows.find((candidate) => candidate.record_id === recordId)
        if (row) return { source: 'local', recordId: row.record_id }
      }
    }
    return hostedMessageResolution(given)
  }
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
  const mode = boardIdentifierMode(database, environment, validateHosted)
  if (mode === 'hosted') return { source: 'hosted', recordId }
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
  allowLocalMachineScoped = false,
): BoardIdentifierResolution | null {
  try {
    return resolveBoardMessageIdentifier(
      database,
      input,
      environment,
      false,
      allowLocalMachineScoped,
    )
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid board-message identifier '))
      return null
    throw error
  }
}
