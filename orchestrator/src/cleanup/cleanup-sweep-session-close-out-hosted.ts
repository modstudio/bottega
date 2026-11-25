// concern: hosted closed-session claim release adapter
/** Reaches the record through the bounded client without exposing transport policy to the sweep. */

import type { Database } from 'bun:sqlite'
import { boundedFetch } from '../../../shared/bounded-fetch.ts'
import {
  type BoardDestinationResolver,
  boardWriteDestination,
} from '../board/board-write-destination.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type { RecordWriteDestination } from '../record/record-api-client-paths.ts'
import { RecordApiRequestError } from '../record/record-api-client-response.ts'

export async function releaseHostedClaims(
  session: string,
  database: Database,
  destinationResolver: BoardDestinationResolver = boardWriteDestination,
): Promise<number> {
  const presence = database
    .query<{ project: string | null }, [string]>('SELECT project FROM presence WHERE session_id=?')
    .get(session)
  const client = recordApiClient(undefined, boundedFetch('hosted-close-out'))
  const project = presence?.project ?? null
  let destination: RecordWriteDestination
  try {
    destination = await destinationResolver(client, project, database)
  } catch (cause) {
    if (!(project !== null && cause instanceof RecordApiRequestError && cause.kind === 'refused'))
      throw cause
    destination = await destinationResolver(client, null, database)
  }
  const result = await client.releaseBoardSessionClaims({ holderSession: session }, destination)
  return result.released
}
