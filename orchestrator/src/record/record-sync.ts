// concern: record-sync
/** Knows ordered delivery of local outbox mutations to the hosted record. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { machine, RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../../shared/record/schema.ts'
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
import { run as runRecord, runScore as runScoreRecord } from '../../../shared/record/schema-run.ts'
import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { db, nowIso } from '../database/db.ts'
import {
  backfillReviewRecords,
  REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT,
  REVIEW_LENS_RECORD_PAYLOAD_CONTRACT,
  REVIEW_READ_RECORD_PAYLOAD_CONTRACT,
  REVIEW_RECORD_PAYLOAD_CONTRACT,
  type ReviewRecordBackfillResult,
} from '../review/review-outbox.ts'
import {
  backfillQuestionRecords,
  QUESTION_RECORD_PAYLOAD_CONTRACT,
} from '../run/question-outbox.ts'
import {
  backfillRunRecords,
  RUN_RECORD_PAYLOAD_CONTRACT,
  type RunRecordBackfillResult,
} from '../run/run-outbox.ts'
import { backfillScoreRecords, SCORE_RECORD_PAYLOAD_CONTRACT } from '../score/score-outbox.ts'
import { VERDICT_PAYLOAD_SCHEMA, type VerdictPayload } from '../verdict/verdict-payload.ts'
import { refuseHostedUnvoid, VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import {
  backfillLandingEvidenceRecords,
  CONTENTION_RECORD_PAYLOAD_CONTRACT,
  LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT,
  LANDING_RECORD_PAYLOAD_CONTRACT,
  LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT,
  LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT,
  type LandingEvidenceBackfillResult,
  TEST_FLAKE_RECORD_PAYLOAD_CONTRACT,
} from './landing-outbox.ts'
import { machineId, machineName } from './machine-identity.ts'
import { pullRecordCache } from './record-cache.ts'
import { reviewReadRecordValues } from './record-review-read.ts'
import { commonReviewRecordValues } from './record-review-values.ts'
import { currentRecordSession } from './record-session.ts'
import { validateRecordVerdict } from './record-verdicts.ts'

type OutboxRow = { id: number; kind: string; record_id: string; payload: string }
type Payload = Record<string, unknown>

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

export type RecordSyncResult = {
  pushed: number
  failed: number
  pending: number
  configured: boolean
  backfill?: RunRecordBackfillResult & {
    scores: number
    reviews: ReviewRecordBackfillResult
    landingEvidence: LandingEvidenceBackfillResult
    questions: { minted: number; enqueued: number }
  }
}
export type RecordSyncOptions = {
  backfill?: boolean
  recordUrl?: string
  local?: Database
  openSql?: (url: string) => SQL
  now?: () => string
  identity?: { id: string; name: string }
  principal?: { userId: string; spaceId: string }
  memberships?: RecordSpaceMembership[]
  projectSpaces?: Record<string, string>
}

type RecordPrincipal = { userId: string; spaceId: string }
async function syncMemberships(
  postgres: SQL,
  principal: RecordPrincipal,
): Promise<RecordSpaceMembership[]> {
  return postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const rows = await tx`
      SELECT m.space_id, s.slug FROM membership m JOIN space s ON s.id=m.space_id
      WHERE m.user_id=${principal.userId}::uuid
    `
    return parseRecordSpaceMemberships(rows)
  })
}

function declaredProjectSpace(
  local: Database,
  projectName: string,
  overrides?: Record<string, string>,
): string | null {
  if (overrides?.[projectName]) return overrides[projectName]!
  const hasProjects = local
    .query<{ present: number }, []>(
      "SELECT count(*) AS present FROM sqlite_master WHERE type='table' AND name='project'",
    )
    .get()?.present
  if (!hasProjects) return null
  const row = local
    .query<{ settings: string }, [string]>('SELECT settings FROM project WHERE name=?')
    .get(projectName)
  if (!row) return null
  const settings = JSON.parse(row.settings) as { space?: unknown }
  return typeof settings.space === 'string' && settings.space.trim() ? settings.space : null
}

export function effectiveProjectSpace(declared: string | null, activeSpaceId: string): string {
  return declared ?? activeSpaceId
}

function projectPrincipal(
  projectName: string | null,
  fallback: RecordPrincipal,
  memberships: readonly RecordSpaceMembership[],
  local: Database,
  overrides?: Record<string, string>,
): RecordPrincipal {
  if (!projectName) return fallback
  const declared = declaredProjectSpace(local, projectName, overrides)
  const effectiveSpace = effectiveProjectSpace(declared, fallback.spaceId)
  if (effectiveSpace === fallback.spaceId) return fallback
  const membership = recordSpaceMembership(effectiveSpace, memberships)
  if (!membership) {
    throw new Error(
      `project ${projectName} declares record space ${declared}, but the signed-in user is not a member; join it first with an invitation, then retry`,
    )
  }
  return { userId: fallback.userId, spaceId: membership.spaceId }
}

function cachedProjectPrincipal(
  principals: Map<string | null, RecordPrincipal>,
  projectName: string | null,
  resolve: () => RecordPrincipal,
): RecordPrincipal {
  const existing = principals.get(projectName)
  if (existing) return existing
  const resolved = resolve()
  principals.set(projectName, resolved)
  return resolved
}

/**
 * The project named by a declared-space refusal, if that is what failed.
 *
 * `projectPrincipal` refuses when a project declares a space the signed-in user
 * is not a member of. That is one project's problem, so sync skips its rows and
 * carries on rather than stopping at the first of them.
 */
export function unreachableSpaceProject(detail: string): string | null {
  return /project (.+?) declares record space /.exec(detail)?.[1] ?? null
}

async function bindPrincipal(tx: SQL, principal: RecordPrincipal): Promise<void> {
  await tx`SELECT set_config('app.user_id', ${principal.userId}, true)`
  await tx`SELECT set_config('app.space_id', ${principal.spaceId}, true)`
}

function payload(source: string, kind: keyof typeof recordKinds): Payload {
  const parsed = JSON.parse(source) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('outbox payload must be a JSON object')
  }
  for (const [column, fill] of Object.entries(recordKinds[kind].laterAdded)) {
    if (!Object.hasOwn(parsed, column)) Object.assign(parsed, { [column]: fill })
  }
  const keys = Object.keys(parsed).sort()
  const expected = [...recordKinds[kind].columns].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${kind} outbox payload has an unexpected column set`)
  }
  return parsed as Payload
}

function outboxProjectName(kind: string, record: Payload, local: Database): string | null {
  const direct = nullableString(record.projectName)
  if (direct) return direct
  const hasProjects = local
    .query<{ present: number }, []>(
      "SELECT count(*) AS present FROM sqlite_master WHERE type='table' AND name='project'",
    )
    .get()?.present
  if (!hasProjects) return null
  if (kind === 'score') {
    return (
      local
        .query<{ name: string }, [string]>(
          'SELECT project.name FROM run JOIN project ON project.id=run.project_id WHERE run.record_id=?',
        )
        .get(String(record.id))?.name ?? null
    )
  }
  if (kind === 'review_lens' || kind === 'review_finding') {
    return (
      local
        .query<{ name: string }, [string]>(
          'SELECT project.name FROM review JOIN project ON project.id=review.project_id WHERE review.record_id=?',
        )
        .get(String(record.reviewId))?.name ?? null
    )
  }
  return null
}

const date = (value: unknown) => new Date(String(value))
const nullableDate = (value: unknown) => (value == null ? null : date(value))
const bigint = (value: unknown) => BigInt(String(value))
const nullableBigint = (value: unknown) => (value == null ? null : bigint(value))
const nullableNumber = (value: unknown) => (value == null ? null : Number(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))
const jsonString = (value: unknown) => (value == null ? null : JSON.stringify(value))

function errorDetail(error: unknown): string {
  const details: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const message = current instanceof Error ? current.message : String(current)
    const code = 'code' in current && typeof current.code === 'string' ? current.code : null
    const detail = code ? `[${code}] ${message}` : message
    if (!details.includes(detail)) details.push(detail)
    current = 'cause' in current ? current.cause : null
  }
  return details.join('\ncaused by: ')
}

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
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  }
}

function scoreValues(row: VerdictPayload) {
  return {
    runId: String(row.id),
    spaceId: String(row.spaceId),
    delivery: String(row.delivery),
    quality: nullableString(row.quality),
    fidelity: nullableString(row.fidelity),
    note: nullableString(row.note),
    scoredAt: date(row.scoredAt),
    scoredBy: String(row.scoredBy),
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

export async function refuseOwnerConnection(postgres: SQL, operation = 'sync'): Promise<void> {
  const principals = await postgres`SELECT current_user AS principal`
  if (principals[0]?.principal === RECORD_OWNER_ROLE) {
    throw new Error(
      `record ${operation} refuses ${RECORD_OWNER_ROLE} credentials; set ORCH_RECORD_URL to the ${RECORD_ACTOR_ROLE} connection`,
    )
  }
}

function hostedUnvoidNote(value: unknown): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).note !== 'string'
  ) {
    throw new Error('run outbox evidenceUnvoid must contain a note')
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
    throw new Error(
      'hosted unvoid requires the pending record migration; apply it with `orch record migrate` before retrying',
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
  if (refusal) throw new Error(`refused: ${refusal}`)
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
        throw new Error(`record project is absent: ${projectName}`)
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
  if (!Array.isArray(row.audits)) throw new Error('question outbox audits must be an array')
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
  if (projects.length !== 1) throw new Error(`record project is absent: ${projectName}`)
  return String(projects[0]!.id)
}

const recordKinds = {
  run: {
    ...RUN_RECORD_PAYLOAD_CONTRACT,
    push: pushRun,
  },
  score: {
    ...SCORE_RECORD_PAYLOAD_CONTRACT,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const verdict = VERDICT_PAYLOAD_SCHEMA.parse(row)
        await validateRecordVerdict(tx, verdict)
        const values = scoreValues(verdict)
        const { runId: _runId, ...updates } = values
        await drizzle({ client: tx })
          .insert(runScoreRecord)
          .values(values)
          .onConflictDoUpdate({ target: runScoreRecord.runId, set: updates })
      }),
  },
  question: {
    ...QUESTION_RECORD_PAYLOAD_CONTRACT,
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
    ...REVIEW_RECORD_PAYLOAD_CONTRACT,
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
    ...REVIEW_LENS_RECORD_PAYLOAD_CONTRACT,
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
    ...REVIEW_FINDING_RECORD_PAYLOAD_CONTRACT,
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
    ...REVIEW_READ_RECORD_PAYLOAD_CONTRACT,
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
  landing: {
    ...LANDING_RECORD_PAYLOAD_CONTRACT,
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
    ...LANDING_OVERRIDE_RECORD_PAYLOAD_CONTRACT,
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
    ...LANDING_REVIEW_CARRY_RECORD_PAYLOAD_CONTRACT,
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
    ...LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_CONTRACT,
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
    ...CONTENTION_RECORD_PAYLOAD_CONTRACT,
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
    ...TEST_FLAKE_RECORD_PAYLOAD_CONTRACT,
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
} as const

type OutboxAttempt = {
  row: OutboxRow
  postgres: SQL
  local: Database
  identity: { id: string; name: string }
  principal: RecordPrincipal
  memberships: readonly RecordSpaceMembership[]
  principals: Map<string | null, RecordPrincipal>
  blockedProjects: Set<string>
  projectSpaces?: Record<string, string>
  now: () => string
}

/**
 * One outbox row's push.
 *
 * `skipped` is a row belonging to a project already known to be blocked,
 * `stop` is a failure that ends the pass, and `failed` is a failure that blocks
 * only its own project, so one project's unreachable space cannot keep every
 * other project's evidence out of the record.
 */
async function pushOutboxRow(
  attempt: OutboxAttempt,
): Promise<'pushed' | 'skipped' | 'deferred' | 'failed' | 'stop'> {
  const { row, local, identity } = attempt
  try {
    if (!(row.kind in recordKinds)) throw new Error(`unknown outbox kind: ${row.kind}`)
    const kind = row.kind as keyof typeof recordKinds
    const parsed = payload(row.payload, kind)
    if (kind === 'question' && parsed.runId) {
      const runOutbox = local
        .query<{ synced_at: string | null }, [string]>(
          "SELECT synced_at FROM outbox WHERE kind='run' AND record_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(String(parsed.runId))
      if (!runOutbox?.synced_at) return 'deferred'
    }
    const projectName = outboxProjectName(row.kind, parsed, local)
    if (projectName && attempt.blockedProjects.has(projectName)) return 'skipped'
    const rowPrincipal = cachedProjectPrincipal(attempt.principals, projectName, () =>
      projectPrincipal(
        projectName,
        attempt.principal,
        attempt.memberships,
        local,
        attempt.projectSpaces,
      ),
    )
    const record: Payload = { ...parsed, spaceId: rowPrincipal.spaceId }
    if (String(record.machineId) !== identity.id) {
      throw new Error(
        `${kind} outbox machine ${String(record.machineId)} does not match invoking machine ${identity.id}`,
      )
    }
    await recordKinds[kind].push(attempt.postgres, record, rowPrincipal)
    local
      .query('UPDATE outbox SET synced_at=?, last_error=NULL WHERE id=? AND payload=?')
      .run(attempt.now(), row.id, row.payload)
    return 'pushed'
  } catch (error) {
    const detail = errorDetail(error)
    local
      .query('UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=? AND payload=?')
      .run(detail, row.id, row.payload)
    const blocked = unreachableSpaceProject(detail)
    if (!blocked) return 'stop'
    attempt.blockedProjects.add(blocked)
    return 'failed'
  }
}

export async function syncRecord(options: RecordSyncOptions = {}): Promise<RecordSyncResult> {
  const recordUrl = options.recordUrl ?? process.env.ORCH_RECORD_URL
  const identity = options.identity ?? { id: machineId(), name: machineName() }
  const local = options.local ?? (recordUrl || options.backfill ? db() : undefined)
  const backfill = options.backfill
    ? {
        ...backfillRunRecords(local!, identity.id),
        scores: backfillScoreRecords(local!, identity.id),
        reviews: backfillReviewRecords(local!),
        landingEvidence: backfillLandingEvidenceRecords(local!),
        questions: backfillQuestionRecords(local!),
      }
    : undefined
  if (!recordUrl) {
    return {
      pushed: 0,
      failed: 0,
      pending: 0,
      configured: false,
      ...(backfill ? { backfill } : {}),
    }
  }
  const writableLocal = local!
  const postgres = (options.openSql ?? ((url) => new SQL(url)))(recordUrl)
  let pushed = 0
  let failed = 0
  try {
    await refuseOwnerConnection(postgres)
    const principal: RecordPrincipal =
      options.principal ??
      (await currentRecordSession(recordUrl, writableLocal).then((current) => ({
        userId: current.user.id,
        spaceId: current.activeSpaceId,
      })))
    const memberships =
      options.memberships ?? (options.principal ? [] : await syncMemberships(postgres, principal))
    await upsertMachine(postgres, (options.now ?? nowIso)(), identity, principal)
    const rows = writableLocal
      .query<OutboxRow, []>(
        'SELECT id, kind, record_id, payload FROM outbox WHERE synced_at IS NULL ORDER BY id',
      )
      .all()
      .sort((left, right) => {
        const [leftPhase, leftId] = outboxOrder(left.kind, left.id)
        const [rightPhase, rightId] = outboxOrder(right.kind, right.id)
        return leftPhase - rightPhase || leftId - rightId
      })
    const principals = new Map<string | null, RecordPrincipal>()
    // A project whose declared space this user cannot reach blocks only its own
    // rows. Halting the whole outbox would let one project's misconfiguration
    // stop every other project's evidence from ever reaching the record.
    const blockedProjects = new Set<string>()
    for (const row of rows) {
      const outcome = await pushOutboxRow({
        row,
        postgres,
        local: writableLocal,
        identity,
        principal,
        memberships,
        principals,
        blockedProjects,
        projectSpaces: options.projectSpaces,
        now: options.now ?? nowIso,
      })
      if (outcome === 'pushed') pushed++
      if (outcome === 'failed' || outcome === 'stop') failed++
      if (outcome === 'stop') break
    }
    const pending = writableLocal
      .query<{ count: number }, []>('SELECT count(*) AS count FROM outbox WHERE synced_at IS NULL')
      .get()!.count
    await pullRecordCache(writableLocal)
    return { pushed, failed, pending, configured: true, ...(backfill ? { backfill } : {}) }
  } finally {
    await postgres.close()
  }
}
