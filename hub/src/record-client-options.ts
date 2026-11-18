import { recordRequestHeaders } from '../../shared/record-request-headers.ts'

type RecordAuthHeaders = {
  cookie?: string
  authorization?: string
}

export type RecordFetch = (input: string, init?: RequestInit) => Promise<Response>

export type RecordClientOptions = {
  baseUrl: string
  headers: RecordAuthHeaders
  bearerToken?: string
  fetch?: RecordFetch
  requestDeadlineMs?: number
}

export const recordWriteDestinationHeaders = (spaceId: string) =>
  recordRequestHeaders({
    destinationSpaceId: spaceId,
    headers: { 'content-type': 'application/json' },
  })
