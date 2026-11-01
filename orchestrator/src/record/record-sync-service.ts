// concern: record-sync-service
/** Validates and writes ordered evidence batches under the hosted session's authority. */
import type { SQL } from 'bun'
import { and, sql as drizzleSql, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hostedTaskIdForReference } from '../../../shared/record/hosted-task-id.ts'
import {
  contention as contentionRecord,
  landingOverride as landingOverrideRecord,
  landing as landingRecord,
  landingReviewCarry as landingReviewCarryRecord,
  landingTriageSnapshot as landingTriageSnapshotRecord,
  testFlake as testFlakeRecord,
} from '../../../shared/record/schema-landing.ts'
import {
  hostedQuestionWins,
  question as questionRecord,
} from '../../../shared/record/schema-question.ts'
import {
  reviewFinding as reviewFindingRecord,
  reviewLens as reviewLensRecord,
  reviewRead as reviewReadRecord,
  review as reviewRecord,
} from '../../../shared/record/schema-review.ts'
import { run as runRecord } from '../../../shared/record/schema-run.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { refuseHostedUnvoid, VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import { upsertHostedMachine } from './machine-name-record.ts'
import { OutboxRowError, outboxErrorDetail, outboxFailureDisposition } from './outbox-failure.ts'
import { HostedApiUpgradeRequiredError } from './outbox-held-contract.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { RecordIdentity } from './record-auth.ts'
import { evidenceReferences, type MachineEvidenceTable } from './record-evidence-references.ts'
import { assertRecordPayloadColumns } from './record-payload-columns.ts'
import { recordPool } from './record-pool.ts'
import { pushQuestionAudits } from './record-question-audit.ts'
import { pushReleaseRecord } from './record-release-sync.ts'
import { reviewReadRecordValues } from './record-review-read.ts'
import { commonReviewRecordValues } from './record-review-values.ts'
import { pushBranchDisposal } from './record-sync-branch-disposal.ts'
import type {
  RecordPayload as Payload,
  RecordPrincipal,
  RecordSyncRequest,
  RecordSyncResponse,
  RecordSyncRowResult,
} from './record-sync-contract.ts'
import {
  MachineNameRefusal,
  recordSyncAuthorizationDecision,
  recordSyncReferenceRefusal as referenceRefusal,
} from './record-sync-decision.ts'
import { ownedEvidenceLookup } from './record-sync-evidence-lookup.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { type ProjectResolutionCache, projectRecordId } from './record-sync-project-identity.ts'
import { pullRequestCiRecordKind } from './record-sync-pull-request-ci.ts'
import {
  runProjectTaskIdentityDecision,
  runTaskIdentityDecision,
} from './record-sync-run-task-identity.ts'
import { runRecordValues } from './record-sync-run-values.ts'
import { nullableNumber, nullableRoundedBigint, nullableUuid } from './record-value-conversions.ts'
import { pushScore } from './score-sync.ts'

function payload(source: string, kind: keyof typeof recordKinds): Payload {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new OutboxRowError('outbox payload must be valid JSON', 'payload')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OutboxRowError('outbox payload must be a JSON object', 'payload')
  }
  for (const [column, fill] of Object.entries(recordKinds[kind].laterAdded)) {
    if (!Object.hasOwn(parsed, column)) Object.assign(parsed, { [column]: fill })
  }
  assertRecordPayloadColumns(kind, parsed as Payload, recordKinds[kind].columns)
  return parsed as Payload
}

const date = (value: unknown) => new Date(String(value))
const nullableDate = (value: unknown) => (value == null ? null : date(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))

function evidenceCollision(kind: string, id: string): OutboxRowError {
  return new OutboxRowError(
    `${kind} record ${id} is already owned by another machine or user`,
    'row-validation',
  )
}

async function existingEvidenceOwned(
  tx: SQL,
  table: MachineEvidenceTable,
  id: string,
  machineId: string,
  principal: RecordPrincipal,
): Promise<boolean> {
  const lookup = ownedEvidenceLookup({ ...principal, table, id, machineId, suffix: 'FOR UPDATE' })
  const rows = await tx.unsafe(lookup.text, lookup.values)
  if (rows.length > 0) return true
  const collision = await tx.unsafe(`SELECT id FROM ${table} WHERE id=$1::uuid FOR UPDATE`, [id])
  if (collision.length > 0) throw evidenceCollision(table, id)
  return false
}

function requireOwnedUpsert(
  rows: readonly unknown[],
  kind: string,
  id: string,
  existingOwned = false,
): void {
  if (rows.length === 0 && !existingOwned) throw evidenceCollision(kind, id)
}

async function assertEvidenceReferencesOwned(input: {
  postgres: SQL
  kind: keyof typeof OUTBOX_PAYLOAD_CONTRACTS
  row: Payload
  machineId: string
  principal: RecordPrincipal
}): Promise<void> {
  const references = evidenceReferences(input.kind, input.row)
  if (references.length === 0) return
  await input.postgres.begin(async (tx) => {
    await bindPrincipal(tx, input.principal)
    for (const reference of references) {
      const lookup = ownedEvidenceLookup({
        ...input.principal,
        table: reference.table,
        id: reference.id,
        machineId: input.machineId,
        suffix: '/* owned_reference */',
      })
      const rows = await tx.unsafe(lookup.text, lookup.values)
      if (rows.length === 0) throw new OutboxRowError(referenceRefusal(reference), 'row-validation')
    }
  })
}

function hostedUnvoidNote(value: unknown): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).note !== 'string'
  ) {
    throw new OutboxRowError('run outbox evidenceUnvoid must contain a note', 'row-validation')
  }
  return String((value as Record<string, unknown>).note)
}

async function applyHostedUnvoid(
  tx: SQL,
  runId: string,
  principal: RecordPrincipal,
  evidenceUnvoid: unknown,
): Promise<void> {
  const note = hostedUnvoidNote(evidenceUnvoid)
  const columns = await tx`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='run_exclusion'
      AND column_name IN ('superseded_at','superseded_by','supersede_note')
  `
  if (columns.length !== 3) {
    throw new OutboxRowError(
      `hosted unvoid requires the pending record migration; apply it with \`${PLATFORM_SLUG} record migrate\` before retrying`,
      'migration-mismatch',
    )
  }
  const exclusions = await tx`
    SELECT reason FROM run_exclusion
    WHERE run_id=${runId}::uuid AND space_id=${principal.spaceId}::uuid
      AND superseded_at IS NULL
  `
  const runs = await tx`
    SELECT evidence_excluded FROM run
    WHERE id=${runId}::uuid AND space_id=${principal.spaceId}::uuid
  `
  const exclusionReason = exclusions[0]?.reason
  const runReason = runs[0]?.evidence_excluded
  const activeExclusionReason = exclusionReason == null ? null : String(exclusionReason)
  const runEvidenceExcluded = runReason == null ? null : String(runReason)
  const refusal = refuseHostedUnvoid(activeExclusionReason, runEvidenceExcluded)
  if (refusal) throw new OutboxRowError(`refused: ${refusal}`, 'row-validation')
  if (activeExclusionReason === null && runEvidenceExcluded === null) return
  const now = new Date().toISOString()
  await tx`
    UPDATE run_exclusion
    SET superseded_at=${now}::timestamptz, superseded_by=${principal.userId},
        supersede_note=${note}
    WHERE run_id=${runId}::uuid AND space_id=${principal.spaceId}::uuid
      AND reason=${VOID_EXCLUSION_REASON} AND superseded_at IS NULL
  `
  await tx`
    UPDATE run SET evidence_excluded=NULL, updated_at=${now}::timestamptz
    WHERE id=${runId}::uuid AND space_id=${principal.spaceId}::uuid
      AND evidence_excluded=${VOID_EXCLUSION_REASON}
  `
}

async function pushRun(
  postgres: SQL,
  row: Payload,
  principal: RecordPrincipal,
  projectIds?: ProjectResolutionCache,
): Promise<void> {
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const resolvedProjectId = await projectRecordId(tx, row, principal, projectIds)
    const existingOwned = await existingEvidenceOwned(
      tx,
      'run',
      String(row.id),
      String(row.machineId),
      principal,
    )
    const resolvedTaskId = await hostedTaskIdForReference(tx, principal.spaceId, {
      id: nullableString(row.taskId),
      key: nullableString(row.taskKey),
    })
    const existingTask = (
      await tx<{ task_id: string | null }[]>`SELECT task_id::text AS task_id FROM run
        WHERE space_id=${principal.spaceId}::uuid AND id=${String(row.id)}::uuid`
    )[0]
    const taskId = runTaskIdentityDecision({
      resolvedTaskId,
      existingTaskId: existingTask?.task_id ?? null,
      write: existingOwned ? 'update' : 'insert',
    })
    const taskProjectId =
      resolvedProjectId === null && taskId !== null
        ? ((
            await tx<{ project_id: string | null }[]>`
              SELECT project_id::text AS project_id FROM hub_task
              WHERE space_id=${principal.spaceId}::uuid AND id=${taskId}::uuid
            `
          )[0]?.project_id ?? null)
        : null
    const identity = runProjectTaskIdentityDecision({
      runId: String(row.id),
      payloadProjectId: resolvedProjectId,
      taskId,
      taskProjectId,
      probe: Boolean(row.probe),
      commandName: PLATFORM_SLUG,
    })
    if (identity.refusal !== null) {
      throw new OutboxRowError(identity.refusal, 'row-validation')
    }
    const values = runRecordValues(row, identity.projectId, identity.taskId, principal.userId)
    const evidenceUnvoid = row.evidenceUnvoid
    if (evidenceUnvoid !== null) await applyHostedUnvoid(tx, values.id, principal, evidenceUnvoid)
    const exclusion = await tx`
      SELECT reason FROM run_exclusion WHERE run_id=${values.id}::uuid
        AND space_id=${principal.spaceId}::uuid AND superseded_at IS NULL
    `
    if (exclusion[0]?.reason) values.evidenceExcluded = String(exclusion[0].reason)
    const { id: _id, createdAt: _createdAt, number: _number, ...runUpdates } = values
    const updates = {
      ...runUpdates,
      number: drizzleSql`COALESCE(excluded.number, ${runRecord.number})`,
    }
    const written = await drizzle({ client: tx })
      .insert(runRecord)
      .values(values)
      .onConflictDoUpdate({
        target: runRecord.id,
        set: updates,
        setWhere: and(
          eq(runRecord.machineId, values.machineId),
          eq(runRecord.startedByUserId, principal.userId),
        ),
      })
      .returning({ id: runRecord.id })
    requireOwnedUpsert(written, 'run', values.id, existingOwned)
  })
}

export function reviewValues(row: Payload, projectId: string | null) {
  return {
    ...commonReviewRecordValues(row),
    projectId,
    recordedAt: date(row.recordedAt),
    completedAt: nullableDate(row.completedAt),
    tier: nullableNumber(row.tier),
    tierRisk: nullableNumber(row.tierRisk),
    tierSize: nullableNumber(row.tierSize),
    tierInsertions: nullableNumber(row.tierInsertions),
    tierDeletions: nullableNumber(row.tierDeletions),
    tierReasons: row.tierReasons,
    tierReason: nullableString(row.tierReason),
    role: String(row.role),
    patchId: nullableString(row.patchId),
    pathSet: row.pathSet,
    commitMessage: nullableString(row.commitMessage),
    outdatedAt: nullableDate(row.outdatedAt),
    outdatedReason: nullableString(row.outdatedReason),
    round: nullableNumber(row.round),
  }
}

export const questionValues = (
  row: Payload,
  projectId: string | null,
  workflowTaskId: string | null,
) => ({
  id: String(row.id),
  number: nullableNumber(row.number),
  spaceId: String(row.spaceId),
  runId: nullableString(row.runId),
  workflowKey: nullableString(row.workflowKey),
  workflowTaskId,
  workflowCursorRecordId: nullableUuid(
    row.workflowCursorRecordId,
    'question.workflowCursorRecordId',
  ),
  projectId,
  machineId: String(row.machineId),
  revision: Number(row.revision),
  askedAt: date(row.askedAt),
  question: String(row.question),
  options: row.options,
  recommendation: nullableString(row.recommendation),
  why: nullableString(row.why),
  askedVia: nullableString(row.askedVia),
  answer: nullableString(row.answer),
  answerBasis: nullableString(row.answerBasis),
  answeredAt: nullableDate(row.answeredAt),
  answeredBy: nullableString(row.answeredBy),
  answeredByName: nullableString(row.answeredByName),
  answererKind: nullableString(row.answererKind),
  answerChannel: nullableString(row.answerChannel),
  awaitingOperatorAt: nullableDate(row.awaitingOperatorAt),
  relayedBy: nullableString(row.relayedBy),
  overturnedAt: nullableDate(row.overturnedAt),
  overturnedBy: nullableString(row.overturnedBy),
  overturnedByName: nullableString(row.overturnedByName),
  overturnReason: nullableString(row.overturnReason),
  replacement: nullableString(row.replacement),
  filedAs: nullableString(row.filedAs),
  filedRef: nullableString(row.filedRef),
  filedRecordId: nullableString(row.filedRecordId),
  filedLabel: nullableString(row.filedLabel),
  filedAt: nullableDate(row.filedAt),
  closedAt: nullableDate(row.closedAt),
  closeReason: nullableString(row.closeReason),
  withheldFields: row.withheldFields,
  createdAt: date(row.createdAt),
  updatedAt: date(row.updatedAt),
})

export function reviewLensValues(row: Payload) {
  return {
    ...commonReviewRecordValues(row),
    reviewId: String(row.reviewId),
    runId: String(row.runId),
    lens: String(row.lens),
    agent: String(row.agent),
    model: nullableString(row.model),
    treeInspected: nullableString(row.treeInspected),
    reviewedTree: nullableString(row.reviewedTree),
    standardsRead: row.standardsRead,
    filesCovered: row.filesCovered,
    commandsRun: row.commandsRun,
    couldNotVerify: row.couldNotVerify,
    mcpTools: row.mcpTools,
    docsRead: row.docsRead,
    substitutes: row.substitutes,
    reproduced: nullableString(row.reproduced),
    coverage: nullableString(row.coverage),
    limits: nullableString(row.limits),
    overlap: nullableString(row.overlap),
    selectionReason: nullableString(row.selectionReason),
  }
}

export function reviewFindingValues(row: Payload) {
  return {
    ...commonReviewRecordValues(row),
    reviewId: String(row.reviewId),
    reviewLensId: String(row.reviewLensId),
    ordinal: Number(row.ordinal),
    severity: String(row.severity),
    location: String(row.location),
    evidence: String(row.evidence),
    proposedCorrection: String(row.proposedCorrection),
    disposition: nullableString(row.disposition),
    rejectionCategory: nullableString(row.rejectionCategory),
    triagedSeverity: nullableString(row.triagedSeverity),
    triagedAt: nullableDate(row.triagedAt),
    duplicateOfFindingId: nullableString(row.duplicateOfFindingId),
  }
}

const landingCommonValues = (row: Payload) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  machineId: String(row.machineId),
  createdAt: date(row.createdAt),
  updatedAt: date(row.updatedAt),
})

export function landingValues(row: Payload, projectId: string | null) {
  return {
    ...landingCommonValues(row),
    projectId,
    branch: String(row.branch),
    tip: nullableString(row.tip),
    trunkBefore: nullableString(row.trunkBefore),
    status: String(row.status),
    error: nullableString(row.error),
    sessionId: nullableString(row.sessionId),
    startedAt: date(row.startedAt),
    finishedAt: nullableDate(row.finishedAt),
    pathSet: row.pathSet,
    requestedAt: nullableDate(row.requestedAt),
    steps: row.steps,
    causingLandingId: nullableString(row.causingLandingId),
    withheldFields: row.withheldFields,
  }
}

export function landingOverrideValues(row: Payload, projectId: string | null) {
  return {
    ...landingCommonValues(row),
    projectId,
    branch: String(row.branch),
    tip: String(row.tip),
    tree: String(row.tree),
    patchId: nullableString(row.patchId),
    pathSet: row.pathSet,
    reason: String(row.reason),
    attribution: String(row.attribution),
    missingLenses: row.missingLenses,
    sessionId: nullableString(row.sessionId),
    at: date(row.at),
    withheldFields: row.withheldFields,
  }
}

function landingReviewCarryValues(row: Payload, projectId: string | null) {
  return {
    ...landingCommonValues(row),
    projectId,
    branch: String(row.branch),
    tip: String(row.tip),
    tree: String(row.tree),
    reviewId: String(row.reviewId),
    reviewedCommit: String(row.reviewedCommit),
    reviewedTree: String(row.reviewedTree),
    patchId: String(row.patchId),
    oldBase: String(row.oldBase),
    newBase: String(row.newBase),
    sessionId: nullableString(row.sessionId),
    at: date(row.at),
  }
}

function landingTriageSnapshotValues(row: Payload, projectId: string | null) {
  if (!Array.isArray(row.reviewIds) || row.reviewIds.some((id) => !hasRecordIdShape(String(id)))) {
    throw new Error('landing triage snapshot reviewIds must be an array of UUIDs')
  }
  return {
    ...landingCommonValues(row),
    projectId,
    branch: String(row.branch),
    tip: String(row.tip),
    tree: String(row.tree),
    prNumber: Number(row.prNumber),
    reviewIds: row.reviewIds.map(String),
    patchId: String(row.patchId),
    tier: Number(row.tier),
    lensRounds: Number(row.lensRounds),
    findingCount: Number(row.findingCount),
    admissionPath: String(row.admissionPath),
    readId: nullableString(row.readId),
    overrideId: nullableString(row.overrideId),
    sessionId: nullableString(row.sessionId),
    at: date(row.at),
  }
}

export function contentionValues(row: Payload) {
  return {
    ...landingCommonValues(row),
    at: date(row.at),
    sessionId: nullableString(row.sessionId),
    resourceKind: String(row.resourceKind),
    resourceKey: String(row.resourceKey),
    eventKind: String(row.eventKind),
    durationMs: nullableRoundedBigint(row.durationMs, 'contention.duration_ms'),
    cause: nullableString(row.cause),
    runId: nullableString(row.runId),
    landingId: nullableString(row.landingId),
    hostLoad: row.hostLoad,
    withheldFields: row.withheldFields,
  }
}

export function testFlakeValues(row: Payload) {
  return {
    ...landingCommonValues(row),
    projectId: null,
    test: String(row.test),
    file: String(row.file),
    loadAtFailure: row.loadAtFailure,
    signal: nullableString(row.signal),
    at: date(row.at),
    withheldFields: row.withheldFields,
  }
}

const recordKinds = {
  run: {
    ...OUTBOX_PAYLOAD_CONTRACTS.run,
    push: pushRun,
  },
  score: {
    ...OUTBOX_PAYLOAD_CONTRACTS.score,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        await pushScore(tx, row)
      }),
  },
  question: {
    ...OUTBOX_PAYLOAD_CONTRACTS.question,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const workflowTaskId = await hostedTaskIdForReference(tx, principal.spaceId, {
          id: nullableUuid(row.workflowTaskId, 'question.workflowTaskId'),
          key: nullableString(row.workflowKey),
        })
        const projectId = await projectRecordId(tx, row, principal, projectIds)
        const values = questionValues(row, projectId, workflowTaskId)
        const existingOwned = await existingEvidenceOwned(
          tx,
          'question',
          values.id,
          values.machineId,
          principal,
        )
        const {
          id: _id,
          createdAt: _createdAt,
          number: _number,
          workflowTaskId: _workflowTaskId,
          ...existingUpdates
        } = values
        const updates = {
          ...existingUpdates,
          number: drizzleSql`COALESCE(excluded.number, ${questionRecord.number})`,
          workflowTaskId: drizzleSql`COALESCE(excluded.workflow_task_id, ${questionRecord.workflowTaskId})`,
        }
        const incomingQuestionWins = hostedQuestionWins(
          drizzleSql`excluded.revision`,
          questionRecord.revision,
        )
        const incomingQuestionFillsNumber = and(
          drizzleSql`${questionRecord.number} IS NULL`,
          drizzleSql`excluded.number IS NOT NULL`,
          drizzleSql`excluded.revision = ${questionRecord.revision}`,
        )
        const written = await drizzle({ client: tx })
          .insert(questionRecord)
          .values(values)
          .onConflictDoUpdate({
            target: questionRecord.id,
            set: updates,
            setWhere: and(
              eq(questionRecord.machineId, values.machineId),
              drizzleSql`(${incomingQuestionWins} OR ${incomingQuestionFillsNumber})`,
            ),
          })
          .returning({ id: questionRecord.id })
        requireOwnedUpsert(written, 'question', values.id, existingOwned)
        await pushQuestionAudits(tx, row, values.id, values.spaceId)
      }),
  },
  review: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewValues(row, await projectRecordId(tx, row, principal, projectIds))
        await existingEvidenceOwned(tx, 'review', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(reviewRecord)
          .values(values)
          .onConflictDoUpdate({
            target: reviewRecord.id,
            set: updates,
            setWhere: eq(reviewRecord.machineId, values.machineId),
          })
          .returning({ id: reviewRecord.id })
        requireOwnedUpsert(written, 'review', values.id)
      }),
  },
  review_lens: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review_lens,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      _projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewLensValues(row)
        await existingEvidenceOwned(tx, 'review_lens', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(reviewLensRecord)
          .values(values)
          .onConflictDoUpdate({
            target: reviewLensRecord.id,
            set: updates,
            setWhere: eq(reviewLensRecord.machineId, values.machineId),
          })
          .returning({ id: reviewLensRecord.id })
        requireOwnedUpsert(written, 'review_lens', values.id)
      }),
  },
  review_finding: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review_finding,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewFindingValues(row)
        await existingEvidenceOwned(tx, 'review_finding', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(reviewFindingRecord)
          .values(values)
          .onConflictDoUpdate({
            target: reviewFindingRecord.id,
            set: updates,
            setWhere: eq(reviewFindingRecord.machineId, values.machineId),
          })
          .returning({ id: reviewFindingRecord.id })
        requireOwnedUpsert(written, 'review_finding', values.id)
      }),
  },
  review_read: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review_read,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewReadRecordValues(
          row,
          await projectRecordId(tx, row, principal, projectIds),
          commonReviewRecordValues(row),
        )
        await existingEvidenceOwned(tx, 'review_read', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(reviewReadRecord)
          .values(values)
          .onConflictDoUpdate({
            target: reviewReadRecord.id,
            set: updates,
            setWhere: eq(reviewReadRecord.machineId, values.machineId),
          })
          .returning({ id: reviewReadRecord.id })
        requireOwnedUpsert(written, 'review_read', values.id)
      }),
  },
  release: {
    ...OUTBOX_PAYLOAD_CONTRACTS.release,
    push: (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      pushReleaseRecord(
        postgres,
        row,
        principal,
        (tx, releaseRow, releasePrincipal) =>
          projectRecordId(tx, releaseRow, releasePrincipal, projectIds),
        evidenceCollision,
      ),
  },
  landing: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingValues(row, await projectRecordId(tx, row, principal, projectIds))
        await existingEvidenceOwned(tx, 'landing', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(landingRecord)
          .values(values)
          .onConflictDoUpdate({
            target: landingRecord.id,
            set: updates,
            setWhere: eq(landingRecord.machineId, values.machineId),
          })
          .returning({ id: landingRecord.id })
        requireOwnedUpsert(written, 'landing', values.id)
      }),
  },
  landing_override: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing_override,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingOverrideValues(
          row,
          await projectRecordId(tx, row, principal, projectIds),
        )
        await existingEvidenceOwned(tx, 'landing_override', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(landingOverrideRecord)
          .values(values)
          .onConflictDoUpdate({
            target: landingOverrideRecord.id,
            set: updates,
            setWhere: eq(landingOverrideRecord.machineId, values.machineId),
          })
          .returning({ id: landingOverrideRecord.id })
        requireOwnedUpsert(written, 'landing_override', values.id)
      }),
  },
  landing_review_carry: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing_review_carry,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingReviewCarryValues(
          row,
          await projectRecordId(tx, row, principal, projectIds),
        )
        await existingEvidenceOwned(
          tx,
          'landing_review_carry',
          values.id,
          values.machineId,
          principal,
        )
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(landingReviewCarryRecord)
          .values(values)
          .onConflictDoUpdate({
            target: landingReviewCarryRecord.id,
            set: updates,
            setWhere: eq(landingReviewCarryRecord.machineId, values.machineId),
          })
          .returning({ id: landingReviewCarryRecord.id })
        requireOwnedUpsert(written, 'landing_review_carry', values.id)
      }),
  },
  landing_triage_snapshot: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing_triage_snapshot,
    push: async (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingTriageSnapshotValues(
          row,
          await projectRecordId(tx, row, principal, projectIds),
        )
        await existingEvidenceOwned(
          tx,
          'landing_triage_snapshot',
          values.id,
          values.machineId,
          principal,
        )
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(landingTriageSnapshotRecord)
          .values(values)
          .onConflictDoUpdate({
            target: landingTriageSnapshotRecord.id,
            set: updates,
            setWhere: eq(landingTriageSnapshotRecord.machineId, values.machineId),
          })
          .returning({ id: landingTriageSnapshotRecord.id })
        requireOwnedUpsert(written, 'landing_triage_snapshot', values.id)
      }),
  },
  pull_request_ci: pullRequestCiRecordKind(existingEvidenceOwned, requireOwnedUpsert),
  contention: {
    ...OUTBOX_PAYLOAD_CONTRACTS.contention,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = contentionValues(row)
        await existingEvidenceOwned(tx, 'contention', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(contentionRecord)
          .values(values)
          .onConflictDoUpdate({
            target: contentionRecord.id,
            set: updates,
            setWhere: eq(contentionRecord.machineId, values.machineId),
          })
          .returning({ id: contentionRecord.id })
        requireOwnedUpsert(written, 'contention', values.id)
      }),
  },
  test_flake: {
    ...OUTBOX_PAYLOAD_CONTRACTS.test_flake,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = testFlakeValues(row)
        await existingEvidenceOwned(tx, 'test_flake', values.id, values.machineId, principal)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const written = await drizzle({ client: tx })
          .insert(testFlakeRecord)
          .values(values)
          .onConflictDoUpdate({
            target: testFlakeRecord.id,
            set: updates,
            setWhere: eq(testFlakeRecord.machineId, values.machineId),
          })
          .returning({ id: testFlakeRecord.id })
        requireOwnedUpsert(written, 'test_flake', values.id)
      }),
  },
  branch_disposal: {
    ...OUTBOX_PAYLOAD_CONTRACTS.branch_disposal,
    push: (postgres, row, principal, projectIds) =>
      pushBranchDisposal(postgres, row, principal, projectIds, existingEvidenceOwned),
  },
} as const satisfies Record<
  keyof typeof OUTBOX_PAYLOAD_CONTRACTS,
  {
    columns: readonly string[]
    laterAdded: Readonly<Record<string, unknown>>
    push: (
      postgres: SQL,
      row: Payload,
      principal: RecordPrincipal,
      projectIds?: ProjectResolutionCache,
    ) => Promise<unknown>
  }
>

async function pushHostedRow(input: {
  postgres: SQL
  row: RecordSyncRequest['rows'][number]
  identity: RecordIdentity
  machineId: string
  projectIds: ProjectResolutionCache
}): Promise<RecordSyncRowResult> {
  const { postgres, row, identity } = input
  try {
    if (!(row.kind in recordKinds)) {
      throw new OutboxRowError(`unknown outbox kind: ${row.kind}`, 'payload')
    }
    const kind = row.kind as keyof typeof recordKinds
    const parsed = payload(row.payload, kind)
    const authorization = recordSyncAuthorizationDecision(identity, row.spaceHint)
    if (authorization.status === 'refused') {
      throw new OutboxRowError(
        authorization.reason,
        row.spaceHint ? 'declared-space' : 'row-validation',
        nullableString(parsed.projectName),
      )
    }
    if (authorization.status === 'deferred') {
      return { id: row.id, ...authorization }
    }
    const rowPrincipal = authorization.principal
    const record: Payload = {
      ...parsed,
      spaceId: rowPrincipal.spaceId,
    }
    if (String(record.machineId) !== input.machineId) {
      throw new OutboxRowError(
        `${kind} outbox machine ${String(record.machineId)} does not match invoking machine ${input.machineId}`,
        'row-validation',
      )
    }
    await assertEvidenceReferencesOwned({
      postgres,
      kind,
      row: record,
      machineId: input.machineId,
      principal: rowPrincipal,
    })
    await recordKinds[kind].push(postgres, record, rowPrincipal, input.projectIds)
    return { id: row.id, status: 'synced' }
  } catch (error) {
    if (error instanceof HostedApiUpgradeRequiredError) {
      return { id: row.id, status: 'held', reason: error.message }
    }
    const detail = outboxErrorDetail(error)
    if (outboxFailureDisposition(error) === 'row-fatal') {
      return { id: row.id, status: 'quarantined', reason: detail }
    }
    throw error
  }
}

export async function syncHostedRecord(input: {
  url: string
  identity: RecordIdentity
  request: RecordSyncRequest
  postgres?: SQL
}): Promise<RecordSyncResponse> {
  const postgres = input.postgres ?? recordPool(input.url)
  const activeSpaceId = input.identity.activeSpaceId
  if (!activeSpaceId) throw new Error('record session has no active space')
  let machineNameRefusal: string | undefined
  try {
    await upsertHostedMachine(postgres, input.request.machine.seenAt, input.request.machine, {
      userId: input.identity.user.id,
      spaceId: activeSpaceId,
    })
  } catch (error) {
    if (error instanceof MachineNameRefusal) machineNameRefusal = error.message
    else throw error
  }
  const results: RecordSyncRowResult[] = []
  const projectIds: ProjectResolutionCache = new Map()
  for (const row of input.request.rows) {
    results.push(
      await pushHostedRow({
        postgres,
        row,
        identity: input.identity,
        machineId: input.request.machine.id,
        projectIds,
      }),
    )
  }
  return { results, ...(machineNameRefusal ? { machineNameRefusal } : {}) }
}
