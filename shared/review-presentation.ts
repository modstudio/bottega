// concern: review-presentation
/** One review identity as presented on a run, independent of its backing store. */
type RunDetailReview = {
  id: string
  reviewNumber: number | null
  reviewProjectId: string | null
  recordedAt: string
  completedAt: string | null
  tier: number | null
  patchId: string | null
  commitMessage: string | null
}

export type RunDetailReviewFinding = {
  id: string
  reviewId: string
  reviewLensId: string
  ordinal: number
  severity: string
  location: string
  evidence: string
  proposedCorrection: string
  disposition: string | null
  rejectionCategory: string | null
  triagedSeverity: string | null
  triagedAt: string | null
}

/** Hosted camelCase is the single run-detail lens presentation shape. */
export type RunDetailReviewLens = RunDetailReview & {
  reviewId: string
  runId: string
  lens: string
  agent: string
  model: string | null
  treeInspected: string | null
  reviewedTree: string | null
  standardsRead: unknown[]
  filesCovered: unknown[]
  commandsRun: unknown[]
  couldNotVerify: unknown[]
  mcpTools: unknown[]
  docsRead: unknown[]
  substitutes: unknown[]
  reproduced: string | null
  coverage: string | null
  limits: string | null
  overlap: string | null
  findings: RunDetailReviewFinding[]
}
