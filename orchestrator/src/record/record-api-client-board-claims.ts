// concern: record-api-client-board-claims
/** Builds hosted board-claim requests. */

import {
  type BoardClaimListOptions,
  boardClaimListPath,
  type RecordClientRequest,
  type RecordWriteDestination,
} from './record-api-client-paths.ts'
import type { HostedBoardClaim, HostedBoardTakeClaimInput } from './record-board-contract.ts'

export type RecordBoardClaimClient = {
  takeBoardClaim(
    input: HostedBoardTakeClaimInput,
    destination: RecordWriteDestination,
  ): Promise<HostedBoardClaim & { action: 'taken' | 'renewed' | 'taken-over' }>
  renewBoardClaim(
    id: string,
    destination: RecordWriteDestination,
    input?: { holderSession?: string | null },
  ): Promise<HostedBoardClaim>
  releaseBoardClaim(
    id: string,
    destination: RecordWriteDestination,
    input?: { holderSession?: string | null },
  ): Promise<HostedBoardClaim>
  listBoardClaims(
    project: string,
    projectId?: string | null,
    options?: BoardClaimListOptions,
  ): Promise<{ claims: HostedBoardClaim[] }>
  releaseBoardTaskClaims(
    input: { project: string; projectId?: string | null; key: string },
    destination: RecordWriteDestination,
  ): Promise<{ released: number }>
  releaseBoardSessionClaims(
    input: { holderSession: string },
    destination: RecordWriteDestination,
  ): Promise<{ released: number }>
}

export function recordBoardClaimClient(request: RecordClientRequest): RecordBoardClaimClient {
  return {
    takeBoardClaim: (input, destination) =>
      request('/v1/board/claims', {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    renewBoardClaim: (id, destination, input) =>
      request(`/v1/board/claims/${id}/renew`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        ...destination,
      }),
    releaseBoardClaim: (id, destination, input) =>
      request(`/v1/board/claims/${id}/release`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
        ...destination,
      }),
    listBoardClaims: (project, projectId, options) =>
      request(boardClaimListPath(project, projectId, options)),
    releaseBoardTaskClaims: (input, destination) =>
      request('/v1/board/claims/release-task', {
        method: 'POST',
        body: JSON.stringify(input),
        ...destination,
      }),
    releaseBoardSessionClaims: (input, destination) =>
      request('/v1/board/claims/release-session', {
        method: 'POST',
        body: JSON.stringify(input),
        ...destination,
      }),
  }
}
