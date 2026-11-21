// concern: workflows
/** Shapes evidence contributed by each offered workflow artifact. */

import type { CheckoutEvidenceLocation } from './workflow-checkout-refusal.ts'
import type { NoteFloorEvidence } from './workflow-task-open-with-notes-floor.ts'

export type BottegaCommandIdentity = {
  resolvedCandidate: string | null
  mainCheckoutExecutable: string | null
  installedExecutable: string | null
}

export type ArtifactEvidence = { ref: string; exists: boolean; notice?: string }

export type ValidatedArtifactEvidence = {
  artifact: ArtifactEvidence
  note?: NoteFloorEvidence
  artifactRunOffered?: string
  probe?: { id: number; exitCode: number }
  exec?: {
    id: number
    recordId: string
    command: string
    argv: string[] | null
    commandIdentity?: BottegaCommandIdentity
    exitCode: number
    sessionMatches: boolean
    sessionAdoptedCursor: boolean
    createdAfterStepActivation: boolean
    checkoutLocation: CheckoutEvidenceLocation
    headCommit: string | null
    cursorBranch: string | null
    output: string
    outputWithheld?: boolean
    commandWithheld?: boolean
    pullRequestCondition?: string
  }
  pullRequest?: {
    url: string
    repository: string | null
    projectRepository: string | null
    state: string
    head: string
    base: string
    cursorBranch: string
    trunk: string
  }
}
