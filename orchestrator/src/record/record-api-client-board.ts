// concern: record-api-client
/** Builds hosted board root-message requests. */

import {
  boardClaimListPath,
  type RecordClientRequest,
  type RecordRequestDestination,
} from './record-api-client-paths.ts'
import type {
  HostedBoardAcceptInput,
  HostedBoardChanges,
  HostedBoardFilingCompleteInput,
  HostedBoardFilingFailInput,
  HostedBoardMessage,
  HostedBoardOverview,
  HostedBoardOverviewFilters,
  HostedBoardPostInput,
  HostedBoardPresenceInput,
  HostedBoardReceiptInput,
  HostedBoardReplyInput,
  HostedBoardSessionInput,
  HostedBoardSuccessorInput,
  HostedBoardTakeClaimInput,
} from './record-board-contract.ts'
import { hostedBoardReplyBody } from './record-board-contract.ts'

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

function recordBoardMessageClient(request: RecordClientRequest) {
  return {
    replyBoardMessage: (
      rootId: string,
      input: HostedBoardReplyInput,
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/messages/${rootId}/replies`, {
        method: 'POST',
        body: hostedBoardReplyBody(input),
        ...destination,
      }),
    acceptBoardAnswer: (
      id: string,
      input: HostedBoardAcceptInput,
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/messages/${id}/accept`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...destination,
      }),
    takeBoardFilingLease: (
      id: string,
      input?: HostedBoardSessionInput,
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/messages/${id}/filing-lease`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        ...destination,
      }),
    completeBoardFilingLease: (
      id: string,
      input: HostedBoardFilingCompleteInput,
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/messages/${id}/filing-lease/complete`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...destination,
      }),
    failBoardFilingLease: (
      id: string,
      input: HostedBoardFilingFailInput,
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/messages/${id}/filing-lease/fail`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...destination,
      }),
    getBoardThread: (id: string) => request(`/v1/board/threads/${id}`),
    getBoardStatus: (id: string) => request(`/v1/board/messages/${id}/status`),
    putBoardReceipt: (
      input: HostedBoardReceiptInput,
      signal?: AbortSignal,
      destination?: RecordRequestDestination,
    ) =>
      request('/v1/board/receipts', {
        method: 'PUT',
        body: JSON.stringify(input),
        signal,
        ...destination,
      }),
  }
}

function recordBoardCoordinationClient(request: RecordClientRequest) {
  return {
    takeBoardSuccessor: (
      input: HostedBoardSuccessorInput,
      destination?: RecordRequestDestination,
    ) =>
      request('/v1/board/successor', {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    takeBoardClaim: (input: HostedBoardTakeClaimInput, destination?: RecordRequestDestination) =>
      request('/v1/board/claims', {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    renewBoardClaim: (
      id: string,
      input?: { holderSession?: string | null },
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/claims/${id}/renew`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        ...destination,
      }),
    releaseBoardClaim: (
      id: string,
      input?: { holderSession?: string | null },
      destination?: RecordRequestDestination,
    ) =>
      request(`/v1/board/claims/${id}/release`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        ...destination,
      }),
    listBoardClaims: (project: string, projectId?: string | null) =>
      request(boardClaimListPath(project, projectId)),
  }
}

export function recordBoardClient(request: RecordClientRequest) {
  return {
    ...recordBoardRootClient(request),
    ...recordBoardMessageClient(request),
    ...recordBoardCoordinationClient(request),
  }
}
