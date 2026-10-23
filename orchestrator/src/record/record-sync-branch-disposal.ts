// concern: hosted branch-disposal sync
/** Writes reversible branch-disposal rulings into the hosted record. */

import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { branchDisposal } from '../../../shared/record/schema-landing.ts'
import { OutboxRowError } from './outbox-failure.ts'
import type { ExistingEvidenceOwned } from './record-evidence-references.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { type ProjectResolutionCache, projectRecordId } from './record-sync-project-identity.ts'

function values(row: RecordPayload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId,
    machineId: String(row.machineId),
    branch: String(row.branch),
    tip: String(row.tip),
    taskKey: row.taskKey == null ? null : String(row.taskKey),
    reason: String(row.reason),
    note: String(row.note),
    archiveRef: String(row.archiveRef),
    archiveExpiresAt: new Date(String(row.archiveExpiresAt)),
    actorSession: String(row.actorSession),
    disposedAt: new Date(String(row.disposedAt)),
    withheldFields: row.withheldFields == null ? null : JSON.stringify(row.withheldFields),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

export async function pushBranchDisposal(
  postgres: SQL,
  row: RecordPayload,
  principal: RecordPrincipal,
  projectIds?: ProjectResolutionCache,
  existingEvidenceOwned?: ExistingEvidenceOwned<SQL>,
): Promise<void> {
  if (!existingEvidenceOwned) throw new Error('branch disposal sync requires collision ownership')
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const write = values(row, await projectRecordId(tx, row, principal, projectIds))
    await existingEvidenceOwned(tx, 'branch_disposal', write.id, write.machineId, principal)
    const { id: _id, createdAt: _createdAt, ...updates } = write
    const written = await drizzle({ client: tx })
      .insert(branchDisposal)
      .values(write)
      .onConflictDoUpdate({
        target: branchDisposal.id,
        set: updates,
        setWhere: eq(branchDisposal.machineId, write.machineId),
      })
      .returning({ id: branchDisposal.id })
    if (!written.length)
      throw new OutboxRowError(
        `branch_disposal record ${write.id} is already owned by another machine or user`,
        'row-validation',
      )
  })
}
