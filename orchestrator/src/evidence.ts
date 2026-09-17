// concern: evidence
import type { Database } from 'bun:sqlite'
import {
  missingDeclaredDeliverables,
  type ReaderReply,
  type ReviewReply,
  readerDeliverablesInstruction,
  UNEVIDENCED_DELIVERABLE_ERROR,
} from './contract/contract.ts'
import { provenanceServer } from './mcp-preflight.ts'
import type { CleanReviewEvidence } from './review.ts'
import { recordReview } from './review-triage.ts'

export type EvidencePromptFacts = {
  findingsJob: boolean
  verifyClaimJob: boolean
  readerJob: boolean
  declaredDeliverables: readonly string[]
}

export type EvidencePromptAssessment = {
  readerInstruction: string | null
  requiresCanonSource: boolean
}

/** Decide which evidence requirements execution binds into a new run's prompt. */
export function assessEvidencePrompt(facts: EvidencePromptFacts): EvidencePromptAssessment {
  return {
    readerInstruction: facts.readerJob
      ? readerDeliverablesInstruction([...facts.declaredDeliverables])
      : null,
    requiresCanonSource: facts.findingsJob || facts.verifyClaimJob,
  }
}

export type ProvisionalEvidenceOutcome<FailureKind extends string = string> = {
  status: string
  error: string | null
  failureKind: FailureKind | null
}

export type EvidenceFacts = {
  findingsJob: boolean
  outputPresent: boolean
  reviewReply: ReviewReply | null
  confinementClassification: string | null
  cleanReview: CleanReviewEvidence | null
  otherProjectMcpServers: ReadonlySet<string>
  ownMcpServer: string | undefined
  readerJob: boolean
  declaredDeliverables: readonly string[]
  readerReply: ReaderReply | null
}

export type EvidenceAssessment<FailureKind extends string = string> = ProvisionalEvidenceOutcome<
  FailureKind | 'contract' | 'unevidenced' | 'harness'
> & {
  provenanceWrongProjectTool: string | null
}

/**
 * Assess supplied evidence after execution has provisionally judged the run.
 * The caller applies this override; this concern owns no terminal state.
 */
export function assessEvidence<FailureKind extends string>(
  provisional: ProvisionalEvidenceOutcome<FailureKind>,
  facts: EvidenceFacts,
): EvidenceAssessment<FailureKind> {
  let outcome: ProvisionalEvidenceOutcome<FailureKind | 'contract' | 'unevidenced' | 'harness'> = {
    ...provisional,
  }

  if (
    facts.findingsJob &&
    facts.outputPresent &&
    (outcome.status === 'ok' || facts.confinementClassification !== null)
  ) {
    if (!facts.reviewReply && outcome.status === 'ok') {
      outcome = {
        status: 'failed',
        error:
          'reply did not match the review contract: mandatory PROVENANCE section missing or malformed',
        failureKind: 'contract',
      }
    }
    if (
      facts.reviewReply &&
      outcome.status === 'ok' &&
      facts.confinementClassification !== 'overlapping' &&
      facts.cleanReview
    ) {
      if (facts.cleanReview.failure !== null) {
        outcome = {
          status: 'failed',
          error: facts.cleanReview.failure,
          failureKind: facts.cleanReview.kind,
        }
      } else if (facts.cleanReview.note) {
        outcome.error = outcome.error
          ? `${outcome.error}\n${facts.cleanReview.note}`
          : facts.cleanReview.note
      }
    }
  }

  const provenanceWrongProjectTool =
    facts.reviewReply?.provenance.mcp_tools.find((tool) => {
      const server = provenanceServer(tool, facts.otherProjectMcpServers)
      return Boolean(server && facts.otherProjectMcpServers.has(server))
    }) ?? null
  if (facts.reviewReply && provenanceWrongProjectTool && outcome.status === 'ok') {
    outcome = {
      status: 'failed',
      error: `wrong project: provenance names ${provenanceWrongProjectTool}, expected ${facts.ownMcpServer}`,
      failureKind: 'contract',
    }
  }

  if (outcome.status === 'ok' && facts.readerJob && facts.declaredDeliverables.length) {
    const missing = missingDeclaredDeliverables([...facts.declaredDeliverables], facts.readerReply)
    if (missing.length) {
      outcome = {
        status: 'failed',
        error: `${UNEVIDENCED_DELIVERABLE_ERROR}: ${missing.join(', ')}`,
        failureKind: 'unevidenced',
      }
    }
  }

  return { ...outcome, provenanceWrongProjectTool }
}

/** Record assessed findings inside the transaction owned by execution. */
export function recordEvidence(
  database: Database,
  runId: number,
  reviewReply: ReviewReply,
): number {
  return recordReview(runId, reviewReply, database)
}
