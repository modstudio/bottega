// concern: record-api-client
/** Builds hosted board root-message requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import type {
  HostedBoardMessage,
  HostedBoardOverview,
  HostedBoardOverviewFilters,
  HostedBoardPostInput,
  HostedBoardSessionInput,
} from './record-board-contract.ts'

type BoardRootClient = {
  listBoardMessages(
    query?: HostedBoardOverviewFilters,
    signal?: AbortSignal,
  ): Promise<HostedBoardOverview>
  postBoardMessage(input: HostedBoardPostInput, signal?: AbortSignal): Promise<HostedBoardMessage>
  withdrawBoardMessage(
    id: string,
    input?: HostedBoardSessionInput,
    signal?: AbortSignal,
  ): Promise<HostedBoardMessage>
}

export function recordBoardRootClient(request: RecordClientRequest): BoardRootClient {
  return {
    listBoardMessages: (query = {}, signal) => {
      const search = new URLSearchParams()
      if (query.kind) search.set('kind', query.kind)
      if (query.open !== undefined) search.set('open', String(query.open))
      if (query.includeEnded !== undefined) search.set('includeEnded', String(query.includeEnded))
      if (query.ownTitlePrefix !== undefined) search.set('ownTitlePrefix', query.ownTitlePrefix)
      const suffix = search.toString()
      return request(`/v1/board/messages${suffix ? `?${suffix}` : ''}`, { signal })
    },
    postBoardMessage: (input, signal) =>
      request('/v1/board/messages', { method: 'PUT', body: JSON.stringify(input), signal }),
    withdrawBoardMessage: (id, input, signal) =>
      request(`/v1/board/messages/${id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        signal,
      }),
  }
}
