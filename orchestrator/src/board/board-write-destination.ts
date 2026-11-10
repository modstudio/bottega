// concern: board-write-destination
/** Names the space of every board write; presence uses the checkout session owner. */

import { projectAt } from '../project/projects.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { RecordRequestDestination } from '../record/record-api-client-paths.ts'
import { recordWriteDestination } from '../record/record-write-destination.ts'

export type BoardDestinationResolver = typeof boardWriteDestination
export type BoardPresenceDestinationResolver = typeof boardPresenceDestination

/** Names the space for a board write, using its project when it carries one. */
export async function boardWriteDestination(
  client: RecordApiClient,
  project?: string | null,
): Promise<RecordRequestDestination> {
  return recordWriteDestination(
    client,
    project ? { kind: 'project', name: project } : { kind: 'personal' },
  )
}

export async function boardPresenceDestination(
  client: RecordApiClient,
  cwd: string = process.cwd(),
) {
  return recordWriteDestination(client, {
    kind: 'session',
    checkoutProject: projectAt(cwd)?.name ?? null,
  })
}
