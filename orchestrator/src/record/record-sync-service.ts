// concern: record-sync-service
/** Validates and writes ordered evidence batches under the hosted session's authority. */
import { SQL } from 'bun'
import { sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { machine } from '../../../shared/record/schema.ts'
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
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { recordSpaceAccessDecision } from '../../../shared/record-space-request.ts'
import { refuseHostedUnvoid, VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import { OutboxRowError, outboxErrorDetail, outboxFailureDisposition } from './outbox-failure.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { recordSpaceMembershipRefusal } from './record-project-destination.ts'
import { pushReleaseRecord } from './record-release-sync.ts'
import { reviewReadRecordValues } from './record-review-read.ts'
import { commonReviewRecordValues } from './record-review-values.ts'
import type { RecordIdentity } from './record-auth.ts'
import type {
  RecordSyncRequest,
  RecordSyncResponse,
  RecordSyncRowResult,
} from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'
import type { Payload, RecordPrincipal } from './record-sync-types.ts'
import { pushScore } from './score-sync.ts'

export type RecordSyncAuthorizationDecision =
  | { status: 'allowed'; principal: RecordPrincipal }
  | { status: 'deferred'; reason: string; spaceId: string }
  | { status: 'refused'; reason: string }

export function recordSyncAuthorizationDecision(
  identity: RecordIdentity,
  spaceHint: string | null,
): RecordSyncAuthorizationDecision {
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  const destination = spaceHint ?? identity.activeSpaceId
  if (!destination) return { status: 'refused', reason: 'record session has no active space' }
  const membership = recordSpaceMembership(destination, memberships)
  if (!membership) {
    return { status: 'refused', reason: recordSpaceMembershipRefusal(destination) }
  }
  const access = recordSpaceAccessDecision('write', membership.spaceId, memberships)
  if (!access.allowed) {
    return {
      status: 'deferred',
      reason: `${access.error}; ${access.remedy}`,
      spaceId: membership.spaceId,
    }
  }
  return {
    status: 'allowed',
    principal: { userId: identity.user.id, spaceId: membership.spaceId },
  }
}

export function outboxOrder(kind: string, id: number): readonly [phase: number, id: number] {
  if (kind === 'run') return [0, id]
  switch (kind) {
    case 'score':
    case 'question':
    case 'review':
    case 'review_lens':
    case 'review_finding':
    case 'review_read':
    case 'contention':
      return [2, id]
    default:
      return [1, id]
  }
}

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
  const keys = Object.keys(parsed).sort()
  const expected = [...recordKinds[kind].columns].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new OutboxRowError(`${kind} outbox payload has an unexpected column set`, 'payload')
  }
  return parsed as Payload
}

async function outboxProjectName(
  postgres: SQL,
  kind: string,
  record: Payload,
  principal: RecordPrincipal,
): Promise<string | null> {
  const direct = nullableString(record.projectName)
  if (direct) return direct
  if (kind !== 'score' && kind !== 'review_lens' && kind !== 'review_finding') return null
  return postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const rows =
      kind === 'score'
        ? await tx`SELECT p.name FROM run r JOIN project p ON p.id=r.project_id
            WHERE r.id=${String(record.id)}::uuid AND r.space_id=${principal.spaceId}::uuid`
        : await tx`SELECT p.name FROM review rv JOIN project p ON p.id=rv.project_id
            WHERE rv.id=${String(record.reviewId)}::uuid AND rv.space_id=${principal.spaceId}::uuid`
    return rows[0]?.name == null ? null : String(rows[0].name)
  })
}

const date = (value: unknown) => new Date(String(value))
const nullableDate = (value: unknown) => (value == null ? null : date(value))
const bigint = (value: unknown) => BigInt(String(value))
const nullableBigint = (value: unknown) => (value == null ? null : bigint(value))
const nullableNumber = (value: unknown) => (value == null ? null : Number(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))
const jsonString = (value: unknown) => (value == null ? null : JSON.stringify(value))

function runValues(row: Payload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId,
    machineId: String(row.machineId),
    localId: bigint(row.localId),
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
    vendorTokens: nullableBigint(row.vendorTokens),
    vendorCostUsd: nullableNumber(row.vendorCostUsd),
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
    deviations: nullableNumber(row.deviations),
    escalations: nullableNumber(row.escalations),
    stack: nullableString(row.stack),
    model: nullableString(row.model),
    evidenceExcluded: nullableString(row.evidenceExcluded),
    inputTree: nullableString(row.inputTree),
    headCommit: nullableString(row.headCommit),
    reviewRef: nullableString(row.reviewRef),
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
    withheldFields: jsonString(row.withheldFields),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  }
}

async function upsertMachine(
  postgres: SQL,
  seenAt: string,
  identity: { id: string; name: string },
  principal: RecordPrincipal,
): Promise<void> {
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const record = drizzle({ client: tx })
    await record
      .insert(machine)
      .values({
        id: identity.id,
        userId: principal.userId,
        name: identity.name,
        registeredAt: date(seenAt),
        lastSeen: date(seenAt),
      })
      .onConflictDoUpdate({
        target: machine.id,
        set: { userId: principal.userId, name: identity.name, lastSeen: date(seenAt) },
      })
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
      'hosted unvoid requires the pending record migration; apply it with `orch record migrate` before retrying',
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

async function pushRun(postgres: SQL, row: Payload, principal: RecordPrincipal): Promise<void> {
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const projectName = nullableString(row.projectName)
    let projectId: string | null = null
    if (projectName !== null) {
      const projects = await tx`
        SELECT id FROM project
        WHERE space_id=${principal.spaceId}::uuid AND name=${projectName}
      `
      if (projects.length !== 1) {
        throw new OutboxRowError(`record project is absent: ${projectName}`, 'row-validation')
      }
      projectId = String(projects[0]!.id)
    }
    const values = runValues(row, projectId)
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
    await drizzle({ client: tx })
      .insert(runRecord)
      .values(values)
      .onConflictDoUpdate({ target: runRecord.id, set: updates })
  })
}

function reviewValues(row: Payload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId,
    machineId: String(row.machineId),
    localId: bigint(row.localId),
    recordedAt: date(row.recordedAt),
    completedAt: nullableDate(row.completedAt),
    tier: nullableNumber(row.tier),
    tierRisk: nullableNumber(row.tierRisk),
    tierSize: nullableNumber(row.tierSize),
    tierReasons: jsonString(row.tierReasons),
    tierReason: nullableString(row.tierReason),
    patchId: nullableString(row.patchId),
    pathSet: jsonString(row.pathSet),
    commitMessage: nullableString(row.commitMessage),
    outdatedAt: nullableDate(row.outdatedAt),
    outdatedReason: nullableString(row.outdatedReason),
    withheldFields: jsonString(row.withheldFields),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  }
}

function questionValues(row: Payload, projectId: string | null) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    runId: nullableString(row.runId),
    workflowKey: nullableString(row.workflowKey),
    workflowCursorId: nullableBigint(row.workflowCursorId),
    projectId,
    machineId: String(row.machineId),
    localId: bigint(row.localId),
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
  }
}

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
  }
}

const landingCommonValues = (row: Payload) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  machineId: String(row.machineId),
  localId: bigint(row.localId),
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
  return {
    ...landingCommonValues(row),
    projectId,
    branch: String(row.branch),
    tip: String(row.tip),
    tree: String(row.tree),
    prNumber: Number(row.prNumber),
    reviewIds: row.reviewIds,
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

async function projectRecordId(
  tx: SQL,
  row: Payload,
  principal: RecordPrincipal,
): Promise<string | null> {
  const projectName = nullableString(row.projectName)
  if (projectName === null) return null
  const projects = await tx`SELECT id FROM project
    WHERE space_id=${principal.spaceId}::uuid AND name=${projectName}`
  if (projects.length !== 1) {
    throw new OutboxRowError(`record project is absent: ${projectName}`, 'row-validation')
  }
  return String(projects[0]!.id)
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
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = questionValues(row, await projectRecordId(tx, row, principal))
        const { id: _id, createdAt: _createdAt, ...updates } = values
        const incomingQuestionWins = hostedQuestionWins(
          drizzleSql`excluded.revision`,
          questionRecord.revision,
        )
        await drizzle({ client: tx }).insert(questionRecord).values(values).onConflictDoUpdate({
          target: questionRecord.id,
          set: updates,
          setWhere: incomingQuestionWins,
        })
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
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewValues(row, await projectRecordId(tx, row, principal))
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(reviewRecord)
          .values(values)
          .onConflictDoUpdate({ target: reviewRecord.id, set: updates })
      }),
  },
  review_lens: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review_lens,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewLensValues(row)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(reviewLensRecord)
          .values(values)
          .onConflictDoUpdate({ target: reviewLensRecord.id, set: updates })
      }),
  },
  review_finding: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review_finding,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewFindingValues(row)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(reviewFindingRecord)
          .values(values)
          .onConflictDoUpdate({ target: reviewFindingRecord.id, set: updates })
      }),
  },
  review_read: {
    ...OUTBOX_PAYLOAD_CONTRACTS.review_read,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = reviewReadRecordValues(
          row,
          await projectRecordId(tx, row, principal),
          commonReviewRecordValues(row),
        )
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(reviewReadRecord)
          .values(values)
          .onConflictDoUpdate({ target: reviewReadRecord.id, set: updates })
      }),
  },
  release: {
    ...OUTBOX_PAYLOAD_CONTRACTS.release,
    push: (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      pushReleaseRecord(postgres, row, principal, projectRecordId),
  },
  landing: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingValues(row, await projectRecordId(tx, row, principal))
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(landingRecord)
          .values(values)
          .onConflictDoUpdate({ target: landingRecord.id, set: updates })
      }),
  },
  landing_override: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing_override,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingOverrideValues(row, await projectRecordId(tx, row, principal))
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(landingOverrideRecord)
          .values(values)
          .onConflictDoUpdate({ target: landingOverrideRecord.id, set: updates })
      }),
  },
  landing_review_carry: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing_review_carry,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingReviewCarryValues(row, await projectRecordId(tx, row, principal))
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(landingReviewCarryRecord)
          .values(values)
          .onConflictDoUpdate({ target: landingReviewCarryRecord.id, set: updates })
      }),
  },
  landing_triage_snapshot: {
    ...OUTBOX_PAYLOAD_CONTRACTS.landing_triage_snapshot,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = landingTriageSnapshotValues(row, await projectRecordId(tx, row, principal))
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(landingTriageSnapshotRecord)
          .values(values)
          .onConflictDoUpdate({ target: landingTriageSnapshotRecord.id, set: updates })
      }),
  },
  contention: {
    ...OUTBOX_PAYLOAD_CONTRACTS.contention,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = contentionValues(row)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(contentionRecord)
          .values(values)
          .onConflictDoUpdate({ target: contentionRecord.id, set: updates })
      }),
  },
  test_flake: {
    ...OUTBOX_PAYLOAD_CONTRACTS.test_flake,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = testFlakeValues(row)
        const { id: _id, createdAt: _createdAt, ...updates } = values
        await drizzle({ client: tx })
          .insert(testFlakeRecord)
          .values(values)
          .onConflictDoUpdate({ target: testFlakeRecord.id, set: updates })
      }),
  },
} as const satisfies Record<
  keyof typeof OUTBOX_PAYLOAD_CONTRACTS,
  {
    columns: readonly string[]
    laterAdded: Readonly<Record<string, unknown>>
    push: (postgres: SQL, row: Payload, principal: RecordPrincipal) => Promise<unknown>
  }
>

async function pushHostedRow(input: {
  postgres: SQL
  row: RecordSyncRequest['rows'][number]
  identity: RecordIdentity
  machineId: string
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
    const record: Payload = { ...parsed, spaceId: rowPrincipal.spaceId }
    if (String(record.machineId) !== input.machineId) {
      throw new OutboxRowError(
        `${kind} outbox machine ${String(record.machineId)} does not match invoking machine ${input.machineId}`,
        'row-validation',
      )
    }
    await outboxProjectName(postgres, row.kind, record, rowPrincipal)
    await recordKinds[kind].push(postgres, record, rowPrincipal)
    return { id: row.id, status: 'synced' }
  } catch (error) {
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
    for (const row of input.request.rows) {
      results.push(
        await pushHostedRow({
          postgres,
          row,
          identity: input.identity,
          machineId: input.request.machine.id,
        }),
      )
    }
    return { results }
  } finally {
    if (!input.postgres) await postgres.close()
  }
}
