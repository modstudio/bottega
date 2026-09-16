// concern: record-sync
/** Knows ordered delivery of local outbox mutations to the hosted record. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { db, nowIso } from './db.ts'
import { machineId, machineName } from './machine-identity.ts'
import { machine, PLATFORM_OPERATOR_USER_ID, PLATFORM_SPACE_ID } from './postgres-schema.ts'
import { run as runRecord } from './postgres-schema-run.ts'
import {
  backfillRunRecords,
  RUN_RECORD_PAYLOAD_COLUMNS,
  type RunRecordBackfillResult,
} from './run-outbox.ts'

type OutboxRow = { id: number; record_id: string; payload: string }
type Payload = Record<(typeof RUN_RECORD_PAYLOAD_COLUMNS)[number], unknown>

export type RecordSyncResult = {
  pushed: number
  failed: number
  pending: number
  configured: boolean
  backfill?: RunRecordBackfillResult
}
export type RecordSyncOptions = {
  backfill?: boolean
  recordUrl?: string
  local?: Database
  openSql?: (url: string) => SQL
  now?: () => string
  identity?: { id: string; name: string }
}

function payload(source: string): Payload {
  const parsed = JSON.parse(source) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('outbox payload must be a JSON object')
  }
  const keys = Object.keys(parsed).sort()
  const expected = [...RUN_RECORD_PAYLOAD_COLUMNS].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('run outbox payload has an unexpected column set')
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

async function upsertMachine(
  postgres: SQL,
  seenAt: string,
  identity: { id: string; name: string },
): Promise<void> {
  await postgres.begin(async (tx) => {
    const record = drizzle({ client: tx })
    await record
      .insert(machine)
      .values({
        id: identity.id,
        userId: PLATFORM_OPERATOR_USER_ID,
        name: identity.name,
        registeredAt: date(seenAt),
        lastSeen: date(seenAt),
      })
      .onConflictDoUpdate({
        target: machine.id,
        set: { userId: PLATFORM_OPERATOR_USER_ID, name: identity.name, lastSeen: date(seenAt) },
      })
  })
}

async function pushRun(postgres: SQL, row: Payload): Promise<void> {
  await postgres.begin(async (tx) => {
    await tx`SELECT set_config('app.space_id', ${PLATFORM_SPACE_ID}, true)`
    const projectName = nullableString(row.projectName)
    let projectId: string | null = null
    if (projectName !== null) {
      const projects = await tx`
        SELECT id FROM project
        WHERE space_id=${PLATFORM_SPACE_ID}::uuid AND name=${projectName}
      `
      if (projects.length !== 1) {
        throw new Error(`record project is absent: ${projectName}`)
      }
      projectId = String(projects[0]!.id)
    }
    const values = runValues(row, projectId)
    const { id: _id, createdAt: _createdAt, ...updates } = values
    await drizzle({ client: tx })
      .insert(runRecord)
      .values(values)
      .onConflictDoUpdate({ target: runRecord.id, set: updates })
  })
}

export async function syncRecord(options: RecordSyncOptions = {}): Promise<RecordSyncResult> {
  const recordUrl = options.recordUrl ?? process.env.ORCH_RECORD_URL
  const identity = options.identity ?? { id: machineId(), name: machineName() }
  const local = options.local ?? (recordUrl || options.backfill ? db() : undefined)
  const backfill = options.backfill ? backfillRunRecords(local!, identity.id) : undefined
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
    await upsertMachine(postgres, (options.now ?? nowIso)(), identity)
    const rows = writableLocal
      .query<OutboxRow, []>(
        'SELECT id, record_id, payload FROM outbox WHERE synced_at IS NULL ORDER BY id',
      )
      .all()
    for (const row of rows) {
      try {
        const run = payload(row.payload)
        if (String(run.machineId) !== identity.id) {
          throw new Error(
            `run outbox machine ${String(run.machineId)} does not match invoking machine ${identity.id}`,
          )
        }
        await pushRun(postgres, run)
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
    return { pushed, failed, pending, configured: true, ...(backfill ? { backfill } : {}) }
  } finally {
    await postgres.close()
  }
}
