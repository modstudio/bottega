// concern: record-api-client
/** Implements the projected routing-evidence request. */

import type { RecordRoutingEvidencePage } from './record-routing-evidence-contract.ts'

type Request = (path: string, init?: RequestInit) => Promise<RecordRoutingEvidencePage>
export type RecordRoutingEvidenceClient = {
  listRoutingEvidence(query: {
    spaceId: string
    limit?: number
    cursor?: string | null
  }): Promise<RecordRoutingEvidencePage>
}

export const recordRoutingEvidenceClient = (request: Request): RecordRoutingEvidenceClient => ({
  listRoutingEvidence: (query) => {
    const search = new URLSearchParams({ spaceId: query.spaceId })
    if (query.limit) search.set('limit', String(query.limit))
    if (query.cursor) search.set('cursor', query.cursor)
    return request(`/v1/routing-evidence?${search}`)
  },
})
