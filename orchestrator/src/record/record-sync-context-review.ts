// concern: record-sync-context-review
/** Validates and stores timed context-review evidence in the hosted record. */

import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { contextReview } from '../../../shared/record/schema-session.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { nonnegativeInteger } from './record-value-conversions.ts'

export const contextReviewRecordKind = (
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) => ({
  ...OUTBOX_PAYLOAD_CONTRACTS.context_review,
  push: async (postgres: SQL, row: RecordPayload, principal: RecordPrincipal) =>
    postgres.begin(async (tx) => {
      await bindPrincipal(tx, principal)
      const items = nonnegativeInteger(row.items, 'context_review.items')
      const flagged = nonnegativeInteger(row.flagged, 'context_review.flagged')
      const intervalMs = nonnegativeInteger(row.intervalMs, 'context_review.interval_ms')
      if (flagged > items) throw new Error('context_review.flagged must not exceed items')
      const values = {
        id: String(row.id),
        spaceId: String(row.spaceId),
        machineId: String(row.machineId),
        sessionId: String(row.sessionId),
        at: recordDate(row.at),
        intervalMs: BigInt(intervalMs),
        items,
        flagged,
        itemIds: String(row.itemIds),
        createdAt: recordDate(row.createdAt),
        updatedAt: recordDate(row.updatedAt),
      }
      const existingOwned = await existingEvidenceOwned(
        tx,
        'context_review',
        values.id,
        values.machineId,
        principal,
        { scope: 'machine' },
      )
      const { id: _id, createdAt: _createdAt, ...updates } = values
      const written = await drizzle({ client: tx })
        .insert(contextReview)
        .values(values)
        .onConflictDoUpdate({
          target: contextReview.id,
          set: updates,
          setWhere: eq(contextReview.machineId, values.machineId),
        })
        .returning({ id: contextReview.id })
      requireOwnedUpsert(written, 'context_review', values.id, existingOwned)
    }),
})
