// concern: record-sync-brief-injection
/** Validates and stores brief-injection evidence in the hosted record. */

import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { briefInjection } from '../../../shared/record/schema-session.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { nullableRoundedBigint } from './record-value-conversions.ts'

const nonnegativeInteger = (value: unknown, field: string): number => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${field} must be a nonnegative integer`)
  return number
}

export function briefInjectionValues(row: RecordPayload) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    machineId: String(row.machineId),
    sessionId: String(row.sessionId),
    at: recordDate(row.at),
    source: String(row.source),
    bytes: nonnegativeInteger(row.bytes, 'brief_injection.bytes'),
    lines: nonnegativeInteger(row.lines, 'brief_injection.lines'),
    cursors: nonnegativeInteger(row.cursors, 'brief_injection.cursors'),
    keylessCursors: nonnegativeInteger(row.keylessCursors, 'brief_injection.keylessCursors'),
    keylessIdleMaxMs: nullableRoundedBigint(
      row.keylessIdleMaxMs,
      'brief_injection.keyless_idle_max_ms',
    ),
    overCap: Boolean(row.overCap),
    createdAt: recordDate(row.createdAt),
    updatedAt: recordDate(row.updatedAt),
  }
}

export const briefInjectionRecordKind = (
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) => ({
  ...OUTBOX_PAYLOAD_CONTRACTS.brief_injection,
  push: async (postgres: SQL, row: RecordPayload, principal: RecordPrincipal) =>
    postgres.begin(async (tx) => {
      await bindPrincipal(tx, principal)
      const values = briefInjectionValues(row)
      const existingOwned = await existingEvidenceOwned(
        tx,
        'brief_injection',
        values.id,
        values.machineId,
        principal,
        { scope: 'machine' },
      )
      const { id: _id, createdAt: _createdAt, ...updates } = values
      const written = await drizzle({ client: tx })
        .insert(briefInjection)
        .values(values)
        .onConflictDoUpdate({
          target: briefInjection.id,
          set: updates,
          setWhere: eq(briefInjection.machineId, values.machineId),
        })
        .returning({ id: briefInjection.id })
      requireOwnedUpsert(written, 'brief_injection', values.id, existingOwned)
    }),
})
