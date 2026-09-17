// concern: record-sync
/** Knows ordered delivery of local outbox mutations to the hosted record. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { machine, RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../../shared/record/schema.ts'
import {
  contention as contentionRecord,
  landingOverride as landingOverrideRecord,
  landing as landingRecord,
  landingReviewCarry as landingReviewCarryRecord,
  testFlake as testFlakeRecord,
} from '../../../shared/record/schema-landing.ts'
import {
  reviewFinding as reviewFindingRecord,
  reviewLens as reviewLensRecord,
  review as reviewRecord,
} from '../../../shared/record/schema-review.ts'
import { run as runRecord, runScore as runScoreRecord } from '../../../shared/record/schema-run.ts'
import { db, nowIso } from '../db.ts'
import {
  backfillLandingEvidenceRecords,
  CONTENTION_RECORD_PAYLOAD_COLUMNS,
  LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS,
  LANDING_RECORD_PAYLOAD_COLUMNS,
  LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS,
  type LandingEvidenceBackfillResult,
  TEST_FLAKE_RECORD_PAYLOAD_COLUMNS,
} from '../landing-outbox.ts'
import { machineId, machineName } from '../machine-identity.ts'
import { pullRecordCache } from './record-cache.ts'
import { currentRecordSession } from './record-session.ts'
import {
  backfillReviewRecords,
  REVIEW_FINDING_RECORD_PAYLOAD_COLUMNS,
  REVIEW_LENS_RECORD_PAYLOAD_COLUMNS,
  REVIEW_RECORD_PAYLOAD_COLUMNS,
  type ReviewRecordBackfillResult,
} from '../review-outbox.ts'
import {
  backfillRunRecords,
  RUN_RECORD_PAYLOAD_COLUMNS,
  type RunRecordBackfillResult,
} from '../run-outbox.ts'
import { backfillScoreRecords, SCORE_RECORD_PAYLOAD_COLUMNS } from '../score-outbox.ts'

type OutboxRow = { id: number; kind: string; record_id: string; payload: string }
type Payload = Record<string, unknown>

export type RecordSyncResult = {
  pushed: number
  failed: number
  pending: number
  configured: boolean
  backfill?: RunRecordBackfillResult & {
    scores: number
    reviews: ReviewRecordBackfillResult
    landingEvidence: LandingEvidenceBackfillResult
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
}

type RecordPrincipal = { userId: string; spaceId: string }

async function bindPrincipal(tx: SQL, principal: RecordPrincipal): Promise<void> {
  await tx`SELECT set_config('app.user_id', ${principal.userId}, true)`
  await tx`SELECT set_config('app.space_id', ${principal.spaceId}, true)`
}

function payload(source: string, kind: keyof typeof recordKinds): Payload {
  const parsed = JSON.parse(source) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('outbox payload must be a JSON object')
  }
  const keys = Object.keys(parsed).sort()
  const expected = [...recordKinds[kind].columns].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${kind} outbox payload has an unexpected column set`)
  }
  return parsed as Payload
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
    startedAt: date(row.startedAt),
    finishedAt: nullableDate(row.finishedAt),
    agent: String(row.agent),
    job: String(row.job),
    promptSha: String(row.promptSha),
    specSha: nullableString(row.specSha),
    promptBytes: bigint(row.promptBytes),
    promptHead: String(row.promptHead),
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

function scoreValues(row: Payload) {
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
    const exclusion = await tx`
      SELECT reason FROM run_exclusion WHERE run_id=${values.id}::uuid AND space_id=${principal.spaceId}::uuid
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

const commonReviewValues = (row: Payload) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  machineId: String(row.machineId),
  localId: bigint(row.localId),
  createdAt: date(row.createdAt),
  updatedAt: date(row.updatedAt),
})

function reviewLensValues(row: Payload) {
  return {
    ...commonReviewValues(row),
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
    ...commonReviewValues(row),
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
  run: { columns: RUN_RECORD_PAYLOAD_COLUMNS, push: pushRun },
  score: {
    columns: SCORE_RECORD_PAYLOAD_COLUMNS,
    push: async (postgres: SQL, row: Payload, principal: RecordPrincipal) =>
      postgres.begin(async (tx) => {
        await bindPrincipal(tx, principal)
        const values = scoreValues(row)
        const { runId: _runId, ...updates } = values
        await drizzle({ client: tx })
          .insert(runScoreRecord)
          .values(values)
          .onConflictDoUpdate({ target: runScoreRecord.runId, set: updates })
      }),
  },
  review: {
    columns: REVIEW_RECORD_PAYLOAD_COLUMNS,
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
    columns: REVIEW_LENS_RECORD_PAYLOAD_COLUMNS,
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
    columns: REVIEW_FINDING_RECORD_PAYLOAD_COLUMNS,
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
  landing: {
    columns: LANDING_RECORD_PAYLOAD_COLUMNS,
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
    columns: LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS,
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
    columns: LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS,
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
  contention: {
    columns: CONTENTION_RECORD_PAYLOAD_COLUMNS,
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
    columns: TEST_FLAKE_RECORD_PAYLOAD_COLUMNS,
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
    await upsertMachine(postgres, (options.now ?? nowIso)(), identity, principal)
    const rows = writableLocal
      .query<OutboxRow, []>(
        'SELECT id, kind, record_id, payload FROM outbox WHERE synced_at IS NULL ORDER BY id',
      )
      .all()
    for (const row of rows) {
      try {
        if (!(row.kind in recordKinds)) throw new Error(`unknown outbox kind: ${row.kind}`)
        const kind = row.kind as keyof typeof recordKinds
        const record = payload(row.payload, kind)
        if (String(record.machineId) !== identity.id) {
          throw new Error(
            `${kind} outbox machine ${String(record.machineId)} does not match invoking machine ${identity.id}`,
          )
        }
        await recordKinds[kind].push(postgres, record, principal)
        writableLocal
          .query('UPDATE outbox SET synced_at=?, last_error=NULL WHERE id=?')
          .run((options.now ?? nowIso)(), row.id)
        pushed++
      } catch (error) {
        const detail = errorDetail(error)
        writableLocal
          .query('UPDATE outbox SET attempts=attempts+1, last_error=? WHERE id=?')
          .run(detail, row.id)
        failed++
        break
      }
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
