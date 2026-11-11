type RecordAuthHeaders = {
  cookie?: string
  authorization?: string
}

export type RecordFetch = (input: string, init?: RequestInit) => Promise<Response>

export type RecordClientOptions = {
  baseUrl: string
  headers: RecordAuthHeaders
  fetch?: RecordFetch
  requestDeadlineMs?: number
}

export const recordWriteDestinationHeaders = (spaceId: string) => ({
  'content-type': 'application/json',
  'x-record-space': spaceId,
})
