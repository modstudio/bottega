// concern: record-api-client-run
/** Owns run-addressed hosted writes and binds each to the run project's destination. */

import type { VerdictInput } from '../verdict/verdict-payload.ts'
import type {
  RecordClientRequest,
  RecordRequestDestination,
  RecordRunMethod,
} from './record-api-client-paths.ts'

type RecordRunClient = {
  putScore(runId: string, input: VerdictInput): Promise<void>
  voidRun(runId: string, input: { reason: string }): Promise<void>
  unvoidRun(runId: string, input: { note: string }): Promise<void>
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
  destinationForRun: (runId: string) => Promise<RecordRequestDestination>,
): Pick<RecordRunClient, RecordRunMethod> {
  return {
    putScore: async (runId, input) =>
      void (await request(`/v1/runs/${runId}/score`, {
        method: 'PUT',
        body: JSON.stringify(input),
        ...(await destinationForRun(runId)),
      })),
    voidRun: async (runId, input) =>
      void (await request(`/v1/runs/${runId}/void`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(await destinationForRun(runId)),
      })),
    unvoidRun: async (runId, input) =>
      void (await request(`/v1/runs/${runId}/unvoid`, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(await destinationForRun(runId)),
      })),
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
