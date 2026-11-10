// concern: record-api-client
/** Builds hosted board root-message requests. */

import type { RecordClientRequest, RecordRequestDestination } from './record-api-client-paths.ts'
import type {
  HostedBoardChanges,
  HostedBoardMessage,
  HostedBoardOverview,
  HostedBoardOverviewFilters,
  HostedBoardPostInput,
  HostedBoardPresenceInput,
  HostedBoardSessionInput,
} from './record-board-contract.ts'

type BoardRootClient = {
  listBoardChanges(
    query: {
      after?: string
      limit?: number
      machineId?: string | null
      presence?: HostedBoardPresenceInput[]
      signal?: AbortSignal
    },
    destination?: RecordRequestDestination,
  ): Promise<HostedBoardChanges>
  listBoardMessages(
    query?: HostedBoardOverviewFilters,
    signal?: AbortSignal,
  ): Promise<HostedBoardOverview>
  postBoardMessage(
    input: HostedBoardPostInput,
    signal?: AbortSignal,
    destination?: RecordRequestDestination,
  ): Promise<HostedBoardMessage>
  withdrawBoardMessage(
    id: string,
    input?: HostedBoardSessionInput,
    signal?: AbortSignal,
    destination?: RecordRequestDestination,
  ): Promise<HostedBoardMessage>
}

export function recordBoardRootClient(request: RecordClientRequest): BoardRootClient {
  return {
    listBoardChanges: (query, destination) => {
      const search = new URLSearchParams()
      if (query.after) search.set('after', query.after)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.machineId) search.set('machineId', query.machineId)
      if (query.presence?.length) search.set('presence', JSON.stringify(query.presence))
      const suffix = search.toString()
      return request(`/v1/board/changes${suffix ? `?${suffix}` : ''}`, {
        signal: query.signal,
        ...destination,
      })
    },
    listBoardMessages: (query = {}, signal) => {
      const search = new URLSearchParams()
      if (query.kind) search.set('kind', query.kind)
      if (query.open !== undefined) search.set('open', String(query.open))
      if (query.includeEnded !== undefined) search.set('includeEnded', String(query.includeEnded))
      if (query.ownTitlePrefix !== undefined) search.set('ownTitlePrefix', query.ownTitlePrefix)
      const suffix = search.toString()
      return request(`/v1/board/messages${suffix ? `?${suffix}` : ''}`, { signal })
    },
    postBoardMessage: (input, signal, destination) =>
      request('/v1/board/messages', {
        method: 'PUT',
        body: JSON.stringify(input),
        signal,
        ...destination,
      }),
    withdrawBoardMessage: (id, input, signal, destination) =>
      request(`/v1/board/messages/${id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        signal,
        ...destination,
      }),
  }
}
