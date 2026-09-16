// concern: review-types

import type { ChangeIdentityGitResult, ChangeIdentityGitRunner } from './change-identity.ts'
import type {
  ReviewCoverage,
  ReviewLimits,
  ReviewOverlap,
  ReviewReproduced,
} from './review-vocabulary.ts'

export type ReviewCoverageInput = {
  id: number
  patchId?: string | null
  pathSet?: string | null
  commitMessage?: string | null
  outdatedReason?: string | null
  lenses: {
    lens: string
    tree: string | null
    inputTree: string | null
    branch: string | null
    baseCommit: string | null
    launchCwd: string | null
    headCommit: string | null
  }[]
}

type ReviewCarry = {
  project: string
  branch: string
  tip: string
  tree: string
  reviewId: number
  reviewedCommit: string
  reviewedTree: string
  patchId: string
  oldBase: string
  newBase: string
}

export type CoverageVerdict =
  | { kind: 'exact' }
  | ({
      kind: 'carried'
      class: 'trivial-rebase' | 'no-code-change'
      resolution: 'pin' | 'walk'
    } & Omit<ReviewCarry, 'project' | 'branch'>)
  | { kind: 'invalid'; reason: string; resolution?: 'pin' | 'walk' }

export type CoverageGitResult = ChangeIdentityGitResult
export type CoverageGitRunner = ChangeIdentityGitRunner

export type ReviewListFilter = {
  state?: 'open' | 'complete'
  project?: string
  since?: string
}

export type ReviewListRow = {
  id: number
  recorded_at: string
  completed_at: string | null
  project: string | null
  branches: string[]
  tier: number | null
  risk: number | null
  size: number | null
  lens_count: number
  findings: {
    total: number
    triaged: number
    accepted: number
    modified: number
    rejected: number
    skipped: number
  }
  coverage: 'exact' | 'trivial-rebase' | 'no-code-change' | 'stale' | null
}

export type ReviewReadLens = ReviewCoverageInput['lenses'][number] & {
  id: number
  runId: number
  agent: string
  model: string | null
  treeInspected: string | null
  reviewRef: string
  reproduced: ReviewReproduced | null
  coverageGrade: ReviewCoverage | null
  limits: ReviewLimits | null
  overlap: ReviewOverlap | null
}

export type RunRow = {
  id: number
  agent: string
  model: string | null
  lens: string | null
  job: string
  status: string
  output_path: string | null
  input_tree: string | null
  head_commit: string | null
  repo: string | null
  project_id: number | null
  base_commit: string | null
  review_ref: string | null
  changed_paths: string | null
}

export type ReviewChangeRange = { from: string; to: string; paths: string[] | null }
