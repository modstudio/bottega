// concern: dispatch-commands
/** Plain review rows and target identity carried into a later findings prompt. */
export type ReviewFindingMemory = {
  project: string
  branch: string | null
  rows: readonly {
    project: string
    branch: string | null
    reviewRecordId: string
    reviewNumber: number
    completedAt: string | null
    ordinal: number
    disposition: string | null
    location: string
    evidence: string
    rejectionCategory: string | null
    triageReason: string | null
    lens: string
    reviewedCommit: string | null
  }[]
}
