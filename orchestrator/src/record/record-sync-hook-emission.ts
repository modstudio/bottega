// concern: record-sync-hook-emission
/** Validates and stores hook-emission evidence in the hosted record. */

import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { hookEmission } from '../../../shared/record/schema-session.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { nonnegativeInteger } from './record-value-conversions.ts'

export const hookEmissionRecordKind = (
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) => ({
  ...OUTBOX_PAYLOAD_CONTRACTS.hook_emission,
  push: async (postgres: SQL, row: RecordPayload, principal: RecordPrincipal) =>
    postgres.begin(async (tx) => {
      await bindPrincipal(tx, principal)
      const values = {
        id: String(row.id),
        spaceId: String(row.spaceId),
        machineId: String(row.machineId),
        sessionId: String(row.sessionId),
        at: recordDate(row.at),
        event: String(row.event),
        hook: String(row.hook),
        kind: String(row.kind),
        chars: nonnegativeInteger(row.chars, 'hook_emission.chars'),
        lines: nonnegativeInteger(row.lines, 'hook_emission.lines'),
        textHash: String(row.textHash),
        createdAt: recordDate(row.createdAt),
        updatedAt: recordDate(row.updatedAt),
      }
      const existingOwned = await existingEvidenceOwned(
        tx,
        'hook_emission',
        values.id,
        values.machineId,
        principal,
        { scope: 'machine' },
      )
      const { id: _id, createdAt: _createdAt, ...updates } = values
      const written = await drizzle({ client: tx })
        .insert(hookEmission)
        .values(values)
        .onConflictDoUpdate({
          target: hookEmission.id,
          set: updates,
          setWhere: eq(hookEmission.machineId, values.machineId),
        })
        .returning({ id: hookEmission.id })
      requireOwnedUpsert(written, 'hook_emission', values.id, existingOwned)
    }),
})
