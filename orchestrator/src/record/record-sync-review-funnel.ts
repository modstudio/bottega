// concern: record-sync-review-funnel
/** Validates and stores replayable review-funnel decisions in the hosted record. */
import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { reviewFunnelDecision } from '../../../shared/record/schema-review.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import { commonReviewRecordValues } from './record-review-values.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { type ProjectResolutionCache, projectRecordId } from './record-sync-project-identity.ts'
import { nullableString } from './record-value-conversions.ts'

function values(row: RecordPayload, projectId: string | null) {
  return {
    ...commonReviewRecordValues(row),
    projectId,
    surface: String(row.surface),
    taskKey: nullableString(row.taskKey),
    branch: String(row.branch),
    headCommit: String(row.headCommit),
    patchId: String(row.patchId),
    pathSet: row.pathSet,
    policyVersion: String(row.policyVersion),
    mode: String(row.mode),
    factsDigest: String(row.factsDigest),
    facts: row.facts,
    stack: nullableString(row.stack),
    verdict: row.verdict,
    outcome: String(row.outcome),
    sessionId: nullableString(row.sessionId),
    recordedAt: recordDate(row.recordedAt),
  }
}

export const reviewFunnelDecisionRecordKind = (
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) => ({
  ...OUTBOX_PAYLOAD_CONTRACTS.review_funnel_decision,
  push: async (
    postgres: SQL,
    row: RecordPayload,
    principal: RecordPrincipal,
    projectIds?: ProjectResolutionCache,
  ) =>
    postgres.begin(async (tx) => {
      await bindPrincipal(tx, principal)
      const mapped = values(row, await projectRecordId(tx, row, principal, projectIds))
      await existingEvidenceOwned(
        tx,
        'review_funnel_decision',
        mapped.id,
        mapped.machineId,
        principal,
        { scope: 'machine' },
      )
      const { id: _id, createdAt: _createdAt, ...updates } = mapped
      const written = await drizzle({ client: tx })
        .insert(reviewFunnelDecision)
        .values(mapped)
        .onConflictDoUpdate({
          target: reviewFunnelDecision.id,
          set: updates,
          setWhere: eq(reviewFunnelDecision.machineId, mapped.machineId),
        })
        .returning({ id: reviewFunnelDecision.id })
      requireOwnedUpsert(written, 'review_funnel_decision', mapped.id)
    }),
})
