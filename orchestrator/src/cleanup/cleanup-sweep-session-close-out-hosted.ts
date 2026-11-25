// concern: hosted closed-session claim release adapter
/** Reaches the record through the bounded client without exposing transport policy to the sweep. */

import type { Database } from 'bun:sqlite'
import { boundedFetch } from '../../../shared/bounded-fetch.ts'
import { BoundExceededError } from '../../../shared/call-budgets.ts'
import { boardWriteDestination } from '../board/board-write-destination.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { RecordApiRequestError } from '../record/record-api-client-response.ts'

export async function releaseHostedClaims(session: string, database: Database): Promise<number> {
  const presence = database
    .query<{ project: string | null }, [string]>('SELECT project FROM presence WHERE session_id=?')
    .get(session)
  const client = recordApiClient(undefined, boundedFetch('hosted-close-out'))
  const destination = await boardWriteDestination(client, presence?.project ?? null, database)
  const result = await client.releaseBoardSessionClaims({ holderSession: session }, destination)
  return result.released
}

export function hostedRecordUnreachable(cause: unknown): boolean {
  return (
    cause instanceof BoundExceededError ||
    (cause instanceof RecordApiRequestError && cause.kind === 'unreachable')
  )
}
