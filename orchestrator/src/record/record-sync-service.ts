// concern: record-sync-service
/** Validates and writes ordered evidence batches under the hosted session's authority. */
import { SQL } from 'bun'
import { and, sql as drizzleSql, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
  questionMutationAudit as questionMutationAuditRecord,
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
import { OutboxRowError, outboxErrorDetail, outboxFailureDisposition } from './outbox-failure.ts'
import { HostedApiUpgradeRequiredError } from './outbox-held-contract.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { RecordIdentity } from './record-auth.ts'
import { evidenceReferences, type MachineEvidenceTable } from './record-evidence-references.ts'
import { assertRecordPayloadColumns } from './record-payload-columns.ts'
import { pushReleaseRecord } from './record-release-sync.ts'
import { reviewReadRecordValues } from './record-review-read.ts'
import { commonReviewRecordValues } from './record-review-values.ts'
import { runUsageRecordValues } from './record-run-usage.ts'
import { pushBranchDisposal } from './record-sync-branch-disposal.ts'
import type {
  RecordPayload as Payload,
  RecordPrincipal,
  RecordSyncRequest,
  RecordSyncResponse,
  RecordSyncRowResult,
} from './record-sync-contract.ts'
import {
  RecordSyncRequestRefusal,
  recordSyncAuthorizationDecision,
  recordSyncMachineOwnershipDecision,
  recordSyncReferenceRefusal as referenceRefusal,
} from './record-sync-decision.ts'
import { ownedEvidenceLookup } from './record-sync-evidence-lookup.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import { type ProjectResolutionCache, projectRecordId } from './record-sync-project-identity.ts'
import { pullRequestCiRecordKind } from './record-sync-pull-request-ci.ts'
import { nullableBigint, nullableNumber, nullableUuid } from './record-value-conversions.ts'
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
const bigint = (value: unknown) => BigInt(String(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))
const jsonString = (value: unknown) => (value == null ? null : JSON.stringify(value))
function runValues(row: Payload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId,
    machineId: String(row.machineId),
    startedByUserId: nullableString(row.startedByUserId),
    startedAt: date(row.startedAt),
    finishedAt: nullableDate(row.finishedAt),
    agent: String(row.agent),
    job: String(row.job),
    promptSha: String(row.promptSha),
    specSha: nullableString(row.specSha),
    promptBytes: bigint(row.promptBytes),
    promptHead: String(row.promptHead),
    taskKey: nullableString(row.taskKey),
    label: nullableString(row.label),
    lens: nullableString(row.lens),
    latencyMs: nullableBigint(row.latencyMs),
    exitCode: nullableNumber(row.exitCode),
    outputBytes: nullableBigint(row.outputBytes),
    ...runUsageRecordValues(row),
    probe: Boolean(row.probe),
    failureKind: nullableString(row.failureKind),
    status: String(row.status),
    error: nullableString(row.error),
    retryOf: nullableString(row.retryOf),
    parentRunId: nullableString(row.parentRunId),
    turn: Number(row.turn),
    filesChanged: nullableNumber(row.filesChanged),
    changedPaths: jsonString(row.changedPaths),
    linesAdded: nullableNumber(row.linesAdded),
    linesRemoved: nullableNumber(row.linesRemoved),
    testsRan: nullableNumber(row.testsRan),
    testsPassed: nullableNumber(row.testsPassed),
    testsClaimDisagrees: row.testsClaimDisagrees == null ? null : Boolean(row.testsClaimDisagrees),
    deviations: nullableNumber(row.deviations),
    escalations: nullableNumber(row.escalations),
    stack: nullableString(row.stack),
    model: nullableString(row.model),
    evidenceExcluded: nullableString(row.evidenceExcluded),
    inputTree: nullableString(row.inputTree),
    headCommit: nullableString(row.headCommit),
    reviewRef: nullableString(row.reviewRef),
    reviewRole: nullableString(row.reviewRole),
    branch: nullableString(row.branch),
    baseCommit: nullableString(row.baseCommit),
    mintedBranch: nullableString(row.mintedBranch),
    docsInjected: nullableNumber(row.docsInjected),
    docRevisions: jsonString(row.docRevisions),
    canonSha: nullableString(row.canonSha),
    transport: nullableString(row.transport),
    sessionId: nullableString(row.sessionId),
    routeReason: nullableString(row.routeReason),
    noFailover: Boolean(row.noFailover),
    automaticFailover: Boolean(row.automaticFailover),
    outsideWorktreeWrites: jsonString(row.outsideWorktreeWrites),
    reviewProvenance: jsonString(row.reviewProvenance),
    provenanceStatus: nullableString(row.provenanceStatus),
    workPreserved: Boolean(row.workPreserved),
    closeOutOutcome: nullableString(row.closeOutOutcome),
    closeOutDetail: nullableString(row.closeOutDetail),
    provisioningKind: nullableString(row.provisioningKind),
    provisioningMs: nullableBigint(row.provisioningMs),
    provisioningPhases: jsonString(row.provisioningPhases),
    provisioningEntries: nullableBigint(row.provisioningEntries),
    provisioningEntriesLimited:
      row.provisioningEntriesLimited == null ? null : Boolean(row.provisioningEntriesLimited),
    provisioningHostLoad: jsonString(row.provisioningHostLoad),
    provisioningOutcome: nullableString(row.provisioningOutcome),
    provisioningEntryRoots: jsonString(row.provisioningEntryRoots),
    withheldFields: jsonString(row.withheldFields),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  }
}

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

async function upsertMachine(
  postgres: SQL,
  seenAt: string,
  identity: { id: string; name: string },
  principal: RecordPrincipal,
): Promise<void> {
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const owned = await tx`
      INSERT INTO machine (id,user_id,name,registered_at,last_seen)
      VALUES (${identity.id}::uuid,${principal.userId}::uuid,${identity.name},${seenAt}::timestamptz,
        ${seenAt}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen
      WHERE machine.user_id=excluded.user_id
      RETURNING user_id
    `
    if (owned.length === 0) {
      const owners = await tx`SELECT user_id FROM machine WHERE id=${identity.id}::uuid`
      const decision = recordSyncMachineOwnershipDecision(
        identity.id,
        owners[0]?.user_id == null ? null : String(owners[0].user_id),
        principal.userId,
      )
      if (decision.status === 'refused') throw new RecordSyncRequestRefusal(decision.reason)
      throw new Error(`machine ownership changed while registering ${identity.id}`)
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
    const projectId = await projectRecordId(tx, row, principal, projectIds)
    const values = runValues(row, projectId)
    const existingOwned = await existingEvidenceOwned(
      tx,
      'run',
      values.id,
      values.machineId,
      principal,
    )
    const evidenceUnvoid = row.evidenceUnvoid
    if (evidenceUnvoid !== null) {
      await applyHostedUnvoid(tx, values.id, principal, evidenceUnvoid)
    }
    const exclusion = await tx`
      SELECT reason FROM run_exclusion WHERE run_id=${values.id}::uuid
        AND space_id=${principal.spaceId}::uuid AND superseded_at IS NULL
    `
    if (exclusion[0]?.reason) values.evidenceExcluded = String(exclusion[0].reason)
    const { id: _id, createdAt: _createdAt, ...updates } = values
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

function reviewValues(row: Payload, projectId: string | null) {
  return {
    ...commonReviewRecordValues(row),
    projectId,
    recordedAt: date(row.recordedAt),
    completedAt: nullableDate(row.completedAt),
    tier: nullableNumber(row.tier),
    tierRisk: nullableNumber(row.tierRisk),
    tierSize: nullableNumber(row.tierSize),
    tierReasons: jsonString(row.tierReasons),
    tierReason: nullableString(row.tierReason),
    role: String(row.role),
    patchId: nullableString(row.patchId),
    pathSet: jsonString(row.pathSet),
    commitMessage: nullableString(row.commitMessage),
    outdatedAt: nullableDate(row.outdatedAt),
    outdatedReason: nullableString(row.outdatedReason),
  }
}

const questionValues = (row: Payload, projectId: string | null) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  runId: nullableString(row.runId),
  workflowKey: nullableString(row.workflowKey),
  workflowCursorRecordId: nullableUuid(
    row.workflowCursorRecordId,
    'question.workflowCursorRecordId',
  ),
  projectId,
  machineId: String(row.machineId),
  revision: Number(row.revision),
  askedAt: date(row.askedAt),
  question: String(row.question),
  options: jsonString(row.options),
  recommendation: nullableString(row.recommendation),
  why: nullableString(row.why),
  askedVia: nullableString(row.askedVia),
  answer: nullableString(row.answer),
  answerBasis: nullableString(row.answerBasis),
  answeredAt: nullableDate(row.answeredAt),
  answeredBy: nullableString(row.answeredBy),
  answererKind: nullableString(row.answererKind),
  answerChannel: nullableString(row.answerChannel),
  awaitingOperatorAt: nullableDate(row.awaitingOperatorAt),
  relayedBy: nullableString(row.relayedBy),
  overturnedAt: nullableDate(row.overturnedAt),
  overturnedBy: nullableString(row.overturnedBy),
  overturnReason: nullableString(row.overturnReason),
  replacement: nullableString(row.replacement),
  filedAs: nullableString(row.filedAs),
  filedRef: nullableString(row.filedRef),
  filedRecordId: nullableString(row.filedRecordId),
  filedLabel: nullableString(row.filedLabel),
  filedAt: nullableDate(row.filedAt),
  closedAt: nullableDate(row.closedAt),
  closeReason: nullableString(row.closeReason),
  withheldFields: jsonString(row.withheldFields),
  createdAt: date(row.createdAt),
  updatedAt: date(row.updatedAt),
})

type QuestionAuditPayload = {
  action: unknown
  actorSession: unknown
  at: unknown
  reason: unknown
}

function questionAudits(row: Payload): QuestionAuditPayload[] {
  if (!Array.isArray(row.audits)) {
    throw new OutboxRowError('question outbox audits must be an array', 'row-validation')
  }
  return row.audits as QuestionAuditPayload[]
}

function reviewLensValues(row: Payload) {
  return {
    ...commonReviewRecordValues(row),
    reviewId: String(row.reviewId),
    runId: String(row.runId),
    lens: String(row.lens),
    agent: String(row.agent),
    model: nullableString(row.model),
    treeInspected: nullableString(row.treeInspected),
    reviewedTree: nullableString(row.reviewedTree),
    standardsRead: jsonString(row.standardsRead)!,
    filesCovered: jsonString(row.filesCovered)!,
    commandsRun: jsonString(row.commandsRun)!,
    couldNotVerify: jsonString(row.couldNotVerify)!,
    mcpTools: jsonString(row.mcpTools)!,
    docsRead: jsonString(row.docsRead)!,
    substitutes: jsonString(row.substitutes)!,
    reproduced: nullableString(row.reproduced),
    coverage: nullableString(row.coverage),
    limits: nullableString(row.limits),
    overlap: nullableString(row.overlap),
  }
}

function reviewFindingValues(row: Payload) {
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

function landingValues(row: Payload, projectId: string | null) {
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
    pathSet: jsonString(row.pathSet),
    requestedAt: nullableDate(row.requestedAt),
    steps: jsonString(row.steps),
    causingLandingId: nullableString(row.causingLandingId),
    withheldFields: jsonString(row.withheldFields),
  }
}

function landingOverrideValues(row: Payload, projectId: string | null) {
  return {
    ...landingCommonValues(row),
    projectId,
    branch: String(row.branch),
    tip: String(row.tip),
    tree: String(row.tree),
    patchId: nullableString(row.patchId),
    pathSet: jsonString(row.pathSet),
    reason: String(row.reason),
    sessionId: nullableString(row.sessionId),
    at: date(row.at),
    withheldFields: jsonString(row.withheldFields),
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

function contentionValues(row: Payload) {
  return {
    ...landingCommonValues(row),
    at: date(row.at),
    sessionId: nullableString(row.sessionId),
    resourceKind: String(row.resourceKind),
    resourceKey: String(row.resourceKey),
    eventKind: String(row.eventKind),
    durationMs: nullableBigint(row.durationMs),
    cause: nullableString(row.cause),
    runId: nullableString(row.runId),
    landingId: nullableString(row.landingId),
    withheldFields: jsonString(row.withheldFields),
  }
}

function testFlakeValues(row: Payload) {
  return {
    ...landingCommonValues(row),
    projectId: null,
    test: String(row.test),
    file: String(row.file),
    loadAtFailure: jsonString(row.loadAtFailure)!,
    signal: nullableString(row.signal),
    at: date(row.at),
    withheldFields: jsonString(row.withheldFields),
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
        const values = questionValues(row, await projectRecordId(tx, row, principal, projectIds))
        const existingOwned = await existingEvidenceOwned(
          tx,
          'question',
          values.id,
          values.machineId,
          principal,
        )
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const incomingQuestionWins = hostedQuestionWins(
          drizzleSql`excluded.revision`,
          questionRecord.revision,
        )
        const written = await drizzle({ client: tx })
          .insert(questionRecord)
          .values(values)
          .onConflictDoUpdate({
            target: questionRecord.id,
            set: updates,
            setWhere: and(eq(questionRecord.machineId, values.machineId), incomingQuestionWins),
          })
          .returning({ id: questionRecord.id })
        requireOwnedUpsert(written, 'question', values.id, existingOwned)
        for (const audit of questionAudits(row)) {
          await drizzle({ client: tx })
            .insert(questionMutationAuditRecord)
            .values({
              questionId: values.id,
              spaceId: values.spaceId,
              action: String(audit.action),
              actorSession: nullableString(audit.actorSession),
              at: date(audit.at),
              reason: nullableString(audit.reason),
            })
            .onConflictDoNothing()
        }
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
      ...(kind === 'run' ? { startedByUserId: identity.user.id } : {}),
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
  const postgres = input.postgres ?? new SQL(input.url)
  try {
    const activeSpaceId = input.identity.activeSpaceId
    if (!activeSpaceId) throw new Error('record session has no active space')
    await upsertMachine(postgres, input.request.machine.seenAt, input.request.machine, {
      userId: input.identity.user.id,
      spaceId: activeSpaceId,
    })
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
    return { results }
  } finally {
    if (!input.postgres) await postgres.close()
  }
}
