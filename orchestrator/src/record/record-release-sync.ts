// concern: record-release-sync
/** Knows how one release snapshot is upserted. Must not know local release execution. */

import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { release as releaseRecord } from '../../../shared/record/schema-release.ts'
import { nullableRecordDate, recordDate } from '../../../shared/record-timestamp.ts'
import type { RecordPayload as Payload, RecordPrincipal } from './record-sync-contract.ts'

const nullableNumber = (value: unknown) => (value == null ? null : Number(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))

export function releaseValues(row: Payload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId,
    machineId: String(row.machineId),
    rung: String(row.rung),
    candidateCommit: String(row.candidateCommit),
    trunk: nullableString(row.trunk),
    trunkTip: nullableString(row.trunkTip),
    commitsBehindTrunk: nullableNumber(row.commitsBehindTrunk),
    behindTrunkReason: nullableString(row.behindTrunkReason),
    liveCommitBefore: nullableString(row.liveCommitBefore),
    liveCommitAfter: nullableString(row.liveCommitAfter),
    rollback: Boolean(row.rollback),
    rollbackReason: nullableString(row.rollbackReason),
    actor: String(row.actor),
    sessionId: nullableString(row.sessionId),
    startedAt: recordDate(row.startedAt),
    finishedAt: nullableRecordDate(row.finishedAt),
    exitCode: nullableNumber(row.exitCode),
    liveMatchesCandidate:
      row.liveMatchesCandidate == null ? null : Boolean(row.liveMatchesCandidate),
    warning: nullableString(row.warning),
    withheldFields: row.withheldFields,
    createdAt: recordDate(row.createdAt),
    updatedAt: recordDate(row.updatedAt),
  }
}

export async function pushReleaseRecord(
  postgres: SQL,
  row: Payload,
  principal: RecordPrincipal,
  projectRecordId: (tx: SQL, row: Payload, principal: RecordPrincipal) => Promise<string | null>,
  collisionError: (kind: string, id: string) => Error,
): Promise<void> {
  await postgres.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${principal.userId}, true)`
    await tx`SELECT set_config('app.space_id', ${principal.spaceId}, true)`
    const values = releaseValues(row, await projectRecordId(tx, row, principal))
    const { id: _id, createdAt: _createdAt, ...updates } = values
    const written = await drizzle({ client: tx })
      .insert(releaseRecord)
      .values(values)
      .onConflictDoUpdate({
        target: releaseRecord.id,
        set: updates,
        setWhere: eq(releaseRecord.machineId, values.machineId),
      })
      .returning({ id: releaseRecord.id })
    if (written.length === 0) {
      throw collisionError('release', values.id)
    }
  })
}
