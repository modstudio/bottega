// concern: hosted pull-request CI sync
/** Writes pull-request workflow attempts and collection status into the hosted record. */
import type { SQL } from 'bun'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { pullRequestCi } from '../../../shared/record/schema-landing.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { type ProjectResolutionCache, projectRecordId } from './record-sync-project-identity.ts'

const nullableString = (value: unknown) => (value == null ? null : String(value))
const nullableDate = (value: unknown) => (value == null ? null : new Date(String(value)))
const nullableNumber = (value: unknown) => (value == null ? null : Number(value))

export function pullRequestCiValues(row: RecordPayload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId,
    machineId: String(row.machineId),
    prNumber: Number(row.prNumber),
    recordKind: String(row.recordKind),
    complete: row.complete == null ? null : Boolean(row.complete),
    error: nullableString(row.error),
    workflowRunId: nullableString(row.workflowRunId),
    runAttempt: nullableNumber(row.runAttempt),
    workflowName: nullableString(row.workflowName),
    event: nullableString(row.event),
    headCommit: nullableString(row.headCommit),
    conclusion: nullableString(row.conclusion),
    failedJobs: row.failedJobs,
    workflowCreatedAt: nullableDate(row.workflowCreatedAt),
    workflowCompletedAt: nullableDate(row.workflowCompletedAt),
    recordedAt: new Date(String(row.recordedAt)),
    withheldFields: row.withheldFields,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

async function pushPullRequestCi(
  postgres: SQL,
  row: RecordPayload,
  principal: RecordPrincipal,
  projectIds?: ProjectResolutionCache,
  existingEvidenceOwned?: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert?: RequireOwnedUpsert,
): Promise<void> {
  if (!existingEvidenceOwned) throw new Error('pull-request CI sync requires collision ownership')
  if (!requireOwnedUpsert) throw new Error('pull-request CI sync requires collision refusal')
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const write = pullRequestCiValues(row, await projectRecordId(tx, row, principal, projectIds))
    const existingOwned = await existingEvidenceOwned(
      tx,
      'pull_request_ci',
      write.id,
      write.machineId,
      principal,
    )
    const { id: _id, createdAt: _createdAt, ...updates } = write
    const written = await drizzle({ client: tx })
      .insert(pullRequestCi)
      .values(write)
      .onConflictDoUpdate({
        target: pullRequestCi.id,
        set: updates,
        setWhere: eq(pullRequestCi.machineId, write.machineId),
      })
      .returning({ id: pullRequestCi.id })
    requireOwnedUpsert(written, 'pull_request_ci', write.id, existingOwned)
  })
}

export const pullRequestCiRecordKind = (
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) => ({
  ...OUTBOX_PAYLOAD_CONTRACTS.pull_request_ci,
  push: (
    postgres: SQL,
    row: RecordPayload,
    principal: RecordPrincipal,
    projectIds?: ProjectResolutionCache,
  ) =>
    pushPullRequestCi(
      postgres,
      row,
      principal,
      projectIds,
      existingEvidenceOwned,
      requireOwnedUpsert,
    ),
})
