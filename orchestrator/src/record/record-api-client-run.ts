// concern: record-api-client-run
/** Owns run-addressed hosted writes and binds each to the run project's destination. */

import type {
  RecordClientRequest,
  RecordRequestDestination,
  RecordRunMethod,
} from './record-api-client-paths.ts'

type RecordRunClient = {
  listScores(query: {
    updatedSince?: string
    limit?: number
    cursor?: string | null
  }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>
  counts(destination?: RecordRequestDestination): Promise<{
    docs: number
    revisions: number
    scores: number
    voids: number
  }>
}

export function recordRunClient(
  request: RecordClientRequest,
): Pick<RecordRunClient, RecordRunMethod> {
  return {
    listScores: (query) => {
      const search = new URLSearchParams()
      if (query.updatedSince) search.set('updatedSince', query.updatedSince)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      const suffix = search.toString()
      return request(`/v1/scores${suffix ? `?${suffix}` : ''}`)
    },
    counts: (destination) => request('/v1/docs/counts', destination),
  }
}
