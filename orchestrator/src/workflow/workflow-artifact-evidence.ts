// concern: workflows
/** Shapes evidence contributed by each offered workflow artifact. */

import type { Database } from 'bun:sqlite'
import { parseProbeArtifact, resolveProbeArtifact } from './probe-identifier.ts'
import type { CheckoutEvidenceLocation } from './workflow-checkout-refusal.ts'

export type WorkflowEvidenceInput = {
  ruling?: number
  review?: string
  gate?: string | number
  run?: string
  artifacts?: string[]
  task?: string
  defer?: string
  satisfies?: string
}

export function resolvedOfferedArtifact(d: Database, artifact: string): string {
  const offered = artifact.trim()
  try {
    const parsed = parseProbeArtifact(offered)
    return parsed?.identifier.kind === 'number' ? resolveProbeArtifact(d, offered)! : offered
  } catch {
    return offered
  }
}

export type BottegaCommandIdentity = {
  resolvedCandidate: string | null
  mainCheckoutExecutable: string | null
  installedExecutable: string | null
}

export type ValidatedArtifactEvidence = {
  artifact: { ref: string; exists: boolean }
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
