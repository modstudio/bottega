// concern: record-routing-evidence
/** Declares the projected hosted routing evidence transport shape. */

export type RecordRoutingEvidence = {
  id: string
  spaceId: string
  agent: string
  model: string | null
  job: string
  stack: string | null
  promptBytes: number
  status: string
  failureKind: string | null
  executor: 'external' | 'harness'
  evidenceExcluded: string | null
  startedAt: string
  latencyMs: number | null
  vendorTokens: number | null
  modelCalls: number | null
  peakCallTokens: number | null
  delivery: string | null
  quality: string | null
  fidelity: string | null
  lenses: string[]
}

export type RecordRoutingEvidencePage = {
  items: RecordRoutingEvidence[]
  nextCursor: string | null
  endCursor?: string | null
}
