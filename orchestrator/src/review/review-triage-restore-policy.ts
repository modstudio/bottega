// concern: review-triage-restore-policy
/** Decides whether a finding's outbox triage can be restored without knowing SQLite. */
import type { Disposition } from './review-triage.ts'

export const TRIAGE_RESTORE_SKIP_REASONS = {
  noSource: 'no outbox row',
  nullDisposition: 'latest outbox row has null disposition',
  identityMismatch: 'identity mismatch',
  openReview: 'review is not completed',
  hostedDivergence: 'hosted identity already diverged',
} as const

export type TriageRestoreFinding = {
  id: number
  reviewRecordId: string | null
  ordinal: number
  severity: string
  location: string
  evidence: string
  recordId: string | null
  completedAt: string | null
}

export type TriageRestoreSource = {
  outboxId: number
  recordId: string
  reviewRecordId: string
  localId: number
  ordinal: number
  severity: string
  location: string
  evidence: string
  disposition: Disposition | null
  rejectionCategory: string | null
  triagedSeverity: string | null
  triagedAt: string | null
}

export type TriageRestoreDecision =
  | { action: 'apply'; restoreRecordId: boolean; source: TriageRestoreSource }
  | { action: 'skip'; reason: string }

export type TriageRestoreFacts = {
  finding: TriageRestoreFinding
  source: TriageRestoreSource | null
  sourceStatus: 'missing' | 'invalid' | 'valid'
  liveRecordIdReferenced: boolean
}

function identityMatches(finding: TriageRestoreFinding, source: TriageRestoreSource): boolean {
  return (
    source.localId === finding.id &&
    source.reviewRecordId === finding.reviewRecordId &&
    source.ordinal === finding.ordinal &&
    source.severity === finding.severity &&
    source.location === finding.location &&
    source.evidence === finding.evidence
  )
}

export function decideTriageRestore(facts: TriageRestoreFacts): TriageRestoreDecision {
  const { finding, source } = facts
  if (facts.sourceStatus === 'missing') {
    return { action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.noSource }
  }
  if (!source) return { action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.identityMismatch }
  if (source.disposition === null) {
    return { action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.nullDisposition }
  }
  if (!identityMatches(finding, source)) {
    return { action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.identityMismatch }
  }
  if (finding.completedAt === null) {
    return { action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.openReview }
  }
  const restoreRecordId = finding.recordId !== source.recordId
  if (restoreRecordId && facts.liveRecordIdReferenced) {
    return { action: 'skip', reason: TRIAGE_RESTORE_SKIP_REASONS.hostedDivergence }
  }
  return { action: 'apply', restoreRecordId, source }
}
