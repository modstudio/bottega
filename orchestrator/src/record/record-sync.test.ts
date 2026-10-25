import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { exerciseQuarantinedRedactionSync } from '../../test/fixtures/outbox-redaction.ts'
import {
  localOutbox,
  MACHINE_ID,
  options,
  PROJECT_ID,
  RECORD_ID,
  STAMP,
} from '../../test/fixtures/record-sync.ts'
import { fakePostgres, serverError } from '../../test/fixtures/record-sync-postgres.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { backfillReviewRecords } from '../review/review-outbox.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { enqueueScoreRecord } from '../score/score-outbox.ts'
import { VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import { enqueueContention } from './landing-outbox.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { retireOutboxRow, retryOutboxRow } from './outbox-quarantine.ts'
import { WITHHELD_SECRET_SHAPED } from './outbox-sanitize.ts'
import { syncRecord } from './record-sync.ts'

const LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.landing_override.columns
const LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS =
  OUTBOX_PAYLOAD_CONTRACTS.landing_triage_snapshot.columns
const PULL_REQUEST_CI_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.pull_request_ci.columns

function localPullRequestCiOutbox(): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  const payload = Object.fromEntries(
    PULL_REQUEST_CI_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]),
  )
  Object.assign(payload, {
    id: RECORD_ID,
    spaceId: '01990000-0000-7000-8000-000000000001',
    projectName: PLATFORM_SLUG,
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    prNumber: 1249,
    recordKind: 'attempt',
    workflowRunId: '39882868998',
    runAttempt: 1,
    workflowName: 'check',
    event: 'pull_request',
    headCommit: '088d0f087',
    conclusion: 'success',
    failedJobs: [],
    workflowCreatedAt: STAMP,
    workflowCompletedAt: STAMP,
    recordedAt: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  local
    .query(
      "INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,1,'pull_request_ci',?,?,?)",
    )
    .run(newRecordId(), RECORD_ID, JSON.stringify(payload), STAMP)
  return local
}

function localTriageSnapshotOutbox(mutate: (payload: Record<string, unknown>) => void): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  const payload = Object.fromEntries(
    LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]),
  )
  Object.assign(payload, {
    id: RECORD_ID,
    spaceId: '01990000-0000-7000-8000-000000000001',
    projectName: PLATFORM_SLUG,
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    localId: 42,
    branch: 'DEV-977-old-shape',
    tip: 'tip',
    tree: 'tree',
    prNumber: 586,
    reviewIds: [],
    patchId: 'patch',
    tier: 2,
    lensRounds: 1,
    findingCount: 0,
    admissionPath: 'architect_read',
    overrideId: 'override-record',
    at: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  mutate(payload)
  local
    .query(
      "INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,1,'landing_triage_snapshot',?,?,?)",
    )
    .run(newRecordId(), RECORD_ID, JSON.stringify(payload), STAMP)
  return local
}

function localLandingOverrideOutbox(mutate: (payload: Record<string, unknown>) => void): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  const payload = Object.fromEntries(
    LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]),
  )
  Object.assign(payload, {
    id: RECORD_ID,
    spaceId: '01990000-0000-7000-8000-000000000001',
    projectName: PLATFORM_SLUG,
    projectId: PROJECT_ID,
    machineId: MACHINE_ID,
    localId: 42,
    branch: 'DEV-977-old-shape',
    tip: 'tip',
    tree: 'tree',
    patchId: 'patch',
    pathSet: ['a.ts'],
    reason: 'legacy override',
    sessionId: 'session',
    at: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  mutate(payload)
  local
    .query(
      "INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,1,'landing_override',?,?,?)",
    )
    .run(newRecordId(), RECORD_ID, JSON.stringify(payload), STAMP)
  return local
}

function localScoreOutbox(): Database {
  const local = migratedTestDatabase()
  local
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','ok')`,
    )
    .run(RECORD_ID)
  enqueueRunRecord(local, RECORD_ID, MACHINE_ID, STAMP)
  local.query("UPDATE outbox SET synced_at=? WHERE kind='run'").run(STAMP)
  local
    .query(
      `INSERT INTO score
       (record_id, run_record_id,delivery,quality,fidelity,note,scored_at,scored_by)
       VALUES ('${newRecordId()}', ?,'full','right',NULL,'old',?,'architect')`,
    )
    .run(RECORD_ID, STAMP)
  enqueueScoreRecord(local, RECORD_ID, MACHINE_ID)
  return local
}

test('sync upserts once and a second pass has no run mutation', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, {
    vendorTokens: 101,
    vendorCostUsd: 1.25,
    vendorInputTokens: 102,
    vendorOutputTokens: 103,
    vendorEstimatedCostUsd: 1.5,
    vendorCostSource: 'billed',
    resourceCpuMs: 201.49,
    resourcePeakRssBytes: 202.51,
    resourceSamples: 203,
    resourceSource: 'sampled',
  })
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 1,
    failed: 0,
    pending: 0,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  const firstRunWrites = remote.statements.filter((sql) =>
    sql.toLowerCase().includes('insert into "run"'),
  ).length
  const runWrite = remote.statements.find((sql) => sql.toLowerCase().includes('insert into "run"'))!
  const runColumns = runWrite
    .slice(runWrite.indexOf('(') + 1, runWrite.indexOf(')'))
    .split(',')
    .map((column) => column.replaceAll('"', '').trim())
  const runId = `${RECORD_ID.slice(0, -1)}1`
  const runParameters = remote.parameters.find(
    (parameters) => parameters.includes(runId) && parameters.includes(101n),
  )!
  const valueFor = (column: string) => runParameters[runColumns.indexOf(column)]
  expect({
    vendorTokens: valueFor('vendor_tokens'),
    vendorCostUsd: valueFor('vendor_cost_usd'),
    vendorInputTokens: valueFor('vendor_input_tokens'),
    vendorOutputTokens: valueFor('vendor_output_tokens'),
    vendorEstimatedCostUsd: valueFor('vendor_estimated_cost_usd'),
    vendorCostSource: valueFor('vendor_cost_source'),
    resourceCpuMs: valueFor('resource_cpu_ms'),
    resourcePeakRssBytes: valueFor('resource_peak_rss_bytes'),
    resourceSamples: valueFor('resource_samples'),
    resourceSource: valueFor('resource_source'),
  }).toEqual({
    vendorTokens: 101n,
    vendorCostUsd: 1.25,
    vendorInputTokens: 102n,
    vendorOutputTokens: 103n,
    vendorEstimatedCostUsd: 1.5,
    vendorCostSource: 'billed',
    resourceCpuMs: 201n,
    resourcePeakRssBytes: 203n,
    resourceSamples: 203,
    resourceSource: 'sampled',
  })
  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 0,
    failed: 0,
    pending: 0,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  expect(
    remote.statements.filter((sql) => sql.toLowerCase().includes('insert into "run"')),
  ).toHaveLength(firstRunWrites)
  local.close()
})

test('pull request CI sync inserts, replays idempotently, and refuses another owner', async () => {
  const local = localPullRequestCiOutbox()
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  local.query('UPDATE outbox SET synced_at=NULL').run()
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  expect(
    remote.statements.filter((sql) => sql.toLowerCase().includes('insert into "pull_request_ci"')),
  ).toHaveLength(2)
  local.close()

  const collisionLocal = localPullRequestCiOutbox()
  const collisionRemote = fakePostgres(
    false,
    RECORD_ACTOR_ROLE,
    undefined,
    undefined,
    undefined,
    undefined,
    RECORD_ID,
  )
  expect(await syncRecord(options(collisionLocal, collisionRemote))).toMatchObject({
    pushed: 0,
    failed: 1,
  })
  expect(
    collisionLocal.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!
      .last_error,
  ).toContain('already owned by another machine or user')
  expect(
    collisionRemote.statements.some((sql) =>
      sql.toLowerCase().includes('insert into "pull_request_ci"'),
    ),
  ).toBe(false)
  collisionLocal.close()
})

test('run sync accepts a null resource source', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, { resourceSource: null })
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  local.close()
})

test('run sync rejects an unknown resource source', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, { resourceSource: 'estimated' })
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 0, failed: 1 })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toBe('run.resourceSource must be sampled, none, unavailable, or null')
  local.close()
})

test('a quarantined newer row blocks redaction and becomes final after retry and sync', async () => {
  const remote = fakePostgres(),
    local = localOutbox(1)
  const sync = () => syncRecord(options(local, remote))
  await exerciseQuarantinedRedactionSync(local, sync)
  expect(remote.parameters.flat()).toContain('newer operator-approved value')
  expect(remote.parameters.flat()).not.toContain(WITHHELD_SECRET_SHAPED)
  local.close()
})

test('ordinary sync pushes an asking run before its live question', async () => {
  const local = migratedTestDatabase()
  local
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','asking')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question,asked_via)
       VALUES (1,'${newRecordId()}',?,?,'Which?','live')`,
    )
    .run(RECORD_ID, STAMP)
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  enqueueRunRecord(local, RECORD_ID, MACHINE_ID, STAMP)
  enqueueQuestionRecord(
    local,
    (local.query('SELECT record_id FROM question').get() as { record_id: string }).record_id,
  )

  const remote = fakePostgres()
  const result = await syncRecord(options(local, remote))
  if (result.failed) {
    const failed = local
      .query<{ last_error: string }, []>(
        'SELECT last_error FROM outbox WHERE last_error IS NOT NULL',
      )
      .get()
    throw new Error(failed?.last_error ?? 'question sync failed without an outbox error')
  }
  expect(result).toMatchObject({ pushed: 2, failed: 0, pending: 0 })
  const writes = remote.statements.filter((statement) =>
    statement.toLowerCase().includes('insert into'),
  )
  expect(writes.findIndex((statement) => statement.includes('"run"'))).toBeLessThan(
    writes.findIndex((statement) => statement.includes('"question"')),
  )
  local.close()
})

test('sync supersedes the hosted void before pushing an unvoided run', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, {
    evidenceExcluded: null,
    evidenceUnvoid: { note: 'mistaken void' },
  })
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  expect(remote.statements.some((sql) => sql.includes('UPDATE run_exclusion'))).toBe(true)
  expect(remote.statements.some((sql) => sql.includes('supersede_note'))).toBe(true)
})

test('sync clears a hosted run-row void when no exclusion row exists', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, {
    evidenceExcluded: null,
    evidenceUnvoid: { note: 'mistaken void' },
  })
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, {
    rowReason: null,
    supersededAt: null,
    runReason: VOID_EXCLUSION_REASON,
  })
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  expect(
    remote.statements.some((sql) => sql.includes('UPDATE run SET evidence_excluded=NULL')),
  ).toBe(true)
})

test('sync accepts an unvoid as a no-op when the hosted run has no exclusion', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, {
    evidenceExcluded: null,
    evidenceUnvoid: { note: 'already restored' },
  })
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, {
    rowReason: null,
    supersededAt: null,
    runReason: null,
  })
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  expect(remote.statements.some((sql) => sql.includes('UPDATE run_exclusion'))).toBe(false)
  expect(
    remote.statements.some((sql) => sql.includes('UPDATE run SET evidence_excluded=NULL')),
  ).toBe(false)
})

test('sync refuses an unvoid when the effective hosted exclusion has another reason', async () => {
  const local = localOutbox(1, PLATFORM_SLUG, {
    evidenceExcluded: null,
    evidenceUnvoid: { note: 'wrong exclusion' },
  })
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, {
    rowReason: null,
    supersededAt: null,
    runReason: 'unjudged: owner gone',
  })
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
  })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toContain("actual exclusion is 'unjudged: owner gone'")
})

test('a re-score while the old payload is in flight remains pending and is delivered next', async () => {
  const local = localScoreOutbox()
  const newerStamp = '2026-09-15T01:02:00.000Z'
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, {
    job: 'file-question',
    writesRepo: false,
    findings: false,
    onWrite: () => {
      local
        .query("UPDATE score SET note='new', scored_at=? WHERE run_record_id=?")
        .run(newerStamp, RECORD_ID)
      enqueueScoreRecord(local, RECORD_ID, MACHINE_ID)
    },
  })

  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 1,
    failed: 0,
    pending: 1,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  expect(
    local
      .query<{ synced_at: string | null }, []>("SELECT synced_at FROM outbox WHERE kind='score'")
      .get()!.synced_at,
  ).toBeNull()
  expect(
    JSON.parse(
      local.query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='score'").get()!
        .payload,
    ),
  ).toMatchObject({ note: 'new', scoredAt: newerStamp })

  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 1,
    failed: 0,
    pending: 0,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  const scoreWrites = remote.statements.filter((sql) =>
    sql.toLowerCase().includes('insert into "run_score"'),
  )
  expect(scoreWrites).toHaveLength(2)
  expect(remote.parameters.flat()).toContain('new')
  local.close()
})

test.each([
  {
    name: 'missing findings grades',
    job: { job: 'review-lens', writesRepo: false, findings: true },
    mutate: (_payload: Record<string, unknown>) => {},
    message: 'findings-producing jobs require reproduced, coverage, limits, and overlap',
  },
  {
    name: 'findings flags on a non-findings job',
    job: { job: 'file-question', writesRepo: false, findings: false },
    mutate: (payload: Record<string, unknown>) => {
      Object.assign(payload, {
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'named',
        overlap: 'alone',
      })
    },
    message: 'this job does not produce findings',
  },
  {
    name: 'missing fidelity on a writing job',
    job: { job: 'implement', writesRepo: true, findings: false },
    mutate: (_payload: Record<string, unknown>) => {},
    message: 'repository-writing jobs require a fidelity verdict',
  },
])('score sync refuses $name', async ({ job, mutate, message }) => {
  const local = localScoreOutbox()
  const row = local
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='score'")
    .get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  mutate(payload)
  local.query("UPDATE outbox SET payload=? WHERE kind='score'").run(JSON.stringify(payload))
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, job)

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 0,
    configured: true,
  })
  expect(
    local
      .query<{ last_error: string }, []>("SELECT last_error FROM outbox WHERE kind='score'")
      .get()!.last_error,
  ).toContain(message)
  expect(
    remote.statements.some((sql) => sql.toLowerCase().includes('insert into "run_score"')),
  ).toBe(false)
  local.close()
})

test('an old-shape score payload without projectId or review grades syncs with nulls', async () => {
  const local = localScoreOutbox()
  const row = local
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='score'")
    .get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  delete payload.reproduced
  delete payload.coverage
  delete payload.limits
  delete payload.overlap
  delete payload.projectId
  local.query("UPDATE outbox SET payload=? WHERE kind='score'").run(JSON.stringify(payload))
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  local.close()
})

test('a run payload cannot assert another user as its starter', async () => {
  const local = localOutbox(1)
  const row = local.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  const assertedUser = '01990000-0000-7000-8000-000000000099'
  payload.startedByUserId = assertedUser
  local.query('UPDATE outbox SET payload=?').run(JSON.stringify(payload))
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  expect(remote.parameters.flat()).not.toContain(assertedUser)
  expect(remote.parameters.flat()).toContain('01990000-0000-7000-8000-000000000002')
  local.close()
})

test('an old-shape triage snapshot syncs with declared fills and keeps its override', async () => {
  const local = localTriageSnapshotOutbox((payload) => {
    delete payload.admissionPath
    delete payload.readId
  })
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  const values = remote.parameters.find(
    (parameters) => parameters.includes('override-record') && parameters.includes('exact_review'),
  )
  expect(values).toContain('exact_review')
  expect(values).toContain(null)
  local.close()
})

test('an old-shape landing override syncs with a null change group', async () => {
  const local = localLandingOverrideOutbox((payload) => {
    delete payload.patchId
    delete payload.pathSet
    delete payload.attribution
    delete payload.missingLenses
  })
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  const values = remote.parameters.find((parameters) => parameters.includes('legacy override'))
  expect(values).toContain('operator')
  expect(values).toContain('[]')
  expect(values?.filter((value) => value === null)).toHaveLength(6)
  local.close()
})

test('a held row stays pending while an independent row syncs and then delivers after upgrade', async () => {
  const local = localOutbox(2)
  const first = local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=1').get()!
  local
    .query('UPDATE outbox SET payload=? WHERE id=1')
    .run(JSON.stringify({ ...JSON.parse(first.payload), futureColumn: null }))
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
    pending: 1,
    held: [
      {
        kind: 'run',
        rows: 1,
        reason: expect.stringContaining('unknown columns: futureColumn'),
      },
    ],
  })
  expect(
    local.query('SELECT attempts,synced_at,quarantined_at FROM outbox ORDER BY id').all(),
  ).toEqual([
    { attempts: 1, synced_at: null, quarantined_at: null },
    { attempts: 0, synced_at: STAMP, quarantined_at: null },
  ])

  local.query('UPDATE outbox SET payload=? WHERE id=1').run(first.payload)
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
    pending: 0,
  })
  local.close()
})

test.each([
  {
    name: 'a missing required column',
    mutate: (payload: Record<string, unknown>) => {
      delete payload.branch
    },
  },
  {
    name: 'both an extra and a missing column',
    mutate: (payload: Record<string, unknown>) => {
      delete payload.branch
      Object.assign(payload, { unexpected: null })
    },
  },
])('triage snapshot sync refuses $name', async ({ mutate }) => {
  const local = localTriageSnapshotOutbox(mutate)
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
  })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toBe('landing_triage_snapshot outbox payload has an unexpected column set')
  local.close()
})

test('a row-fatal failure is quarantined and the next independent row is pushed', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(serverError('remote run refusal', 23503))
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 1,
    pending: 0,
    configured: true,
    quarantined: [{ id: 1, kind: 'run', attempts: 1 }],
  })
  const rows = local
    .query('SELECT attempts,last_error,quarantined_at FROM outbox ORDER BY id')
    .all() as {
    attempts: number
    last_error: string | null
    quarantined_at: string | null
  }[]
  expect(rows.map((row) => row.attempts)).toEqual([1, 0])
  expect(rows[0]!.last_error).toContain('Failed query: insert into "run"')
  expect(rows[0]!.last_error).toContain('[23503] remote run refusal')
  expect(rows[0]!.quarantined_at).toBe(STAMP)
  expect(rows[1]!.last_error).toBeNull()
  expect(rows[1]!.quarantined_at).toBeNull()
  local.close()
})

test('a whole-request connection failure leaves every row untouched', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(new Error('connection refused'))
  await expect(syncRecord(options(local, remote))).rejects.toThrow()
  const rows = local
    .query<{ attempts: number; quarantined_at: string | null }, []>(
      'SELECT attempts,quarantined_at FROM outbox ORDER BY id',
    )
    .all()
  expect(rows).toEqual([
    { attempts: 0, quarantined_at: null },
    { attempts: 0, quarantined_at: null },
  ])
  local.close()
})

test('a whole-request grant failure leaves every row untouched', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(serverError('permission denied for table run', 42501))

  await expect(syncRecord(options(local, remote))).rejects.toThrow()
  expect(local.query('SELECT attempts FROM outbox ORDER BY id').all()).toEqual([
    { attempts: 0 },
    { attempts: 0 },
  ])
  local.close()
})

test('a quarantined parent defers its graph until retry delivers the parent', async () => {
  const local = migratedTestDatabase()
  local
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','asking')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES (1,'${newRecordId()}',?,?,'Which?')`,
    )
    .run(RECORD_ID, STAMP)
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  enqueueRunRecord(local, RECORD_ID, MACHINE_ID, STAMP)
  enqueueQuestionRecord(
    local,
    (local.query('SELECT record_id FROM question').get() as { record_id: string }).record_id,
  )
  local
    .query(
      `INSERT INTO score
       (record_id, run_record_id,delivery,quality,fidelity,note,scored_at,scored_by)
       VALUES ('${newRecordId()}', ?,'full','right',NULL,'complete',?,'architect')`,
    )
    .run(RECORD_ID, STAMP)
  enqueueScoreRecord(local, RECORD_ID, MACHINE_ID)
  local
    .query(
      "INSERT INTO review (number,record_id,recorded_at) VALUES (1,'01990000-0000-7000-8000-000000000041',?)",
    )
    .run(STAMP)
  local
    .query(
      `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES ('01990000-0000-7000-8000-000000000042','01990000-0000-7000-8000-000000000041',?,'craft','codex','[]','[]','[]','[]')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO review_finding
       (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction)
       VALUES ('01990000-0000-7000-8000-000000000043','01990000-0000-7000-8000-000000000041','01990000-0000-7000-8000-000000000042',1,'major','a.ts:1','evidence','correct it')`,
    )
    .run()
  backfillReviewRecords(local)
  local
    .query(
      `INSERT INTO contention
       (record_id,at,resource_kind,resource_key,event_kind,run_record_id)
       VALUES ('01990000-0000-7000-8000-000000000077',?,'lock','resource','wait',?)`,
    )
    .run(STAMP, RECORD_ID)
  enqueueContention(local, '01990000-0000-7000-8000-000000000077', STAMP)
  const remote = fakePostgres(
    serverError('new row violates row-level security policy for table "run"', 42501),
  )

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 6,
    quarantined: [{ id: 1, kind: 'run' }],
  })
  expect(local.query('SELECT attempts,quarantined_at FROM outbox WHERE id>1').all()).toEqual(
    Array.from({ length: 6 }, () => ({ attempts: 0, quarantined_at: null })),
  )

  retryOutboxRow(1, local, STAMP, 'architect')
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 7,
    failed: 0,
    pending: 0,
    quarantined: [],
  })
  local.close()
})

test('a quarantined run defers its continuation and retry until the parent syncs', async () => {
  const local = localOutbox(3)
  const parent = local
    .query<{ record_id: string }, []>('SELECT row_id AS record_id FROM outbox WHERE id=1')
    .get()!
  const updatePayload = (id: number, references: Record<string, string>) => {
    const row = local
      .query<{ payload: string }, [number]>('SELECT payload FROM outbox WHERE id=?')
      .get(id)!
    local
      .query('UPDATE outbox SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...JSON.parse(row.payload), ...references }), id)
  }
  updatePayload(2, { parentRunId: parent.record_id })
  updatePayload(3, { retryOf: parent.record_id })
  const remote = fakePostgres(
    serverError('new row violates row-level security policy for table "run"', 42501),
  )

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 2,
    quarantined: [{ id: 1, kind: 'run' }],
  })
  expect(local.query('SELECT attempts,quarantined_at FROM outbox WHERE id>1').all()).toEqual([
    { attempts: 0, quarantined_at: null },
    { attempts: 0, quarantined_at: null },
  ])

  retryOutboxRow(1, local, STAMP, 'architect')
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 3,
    failed: 0,
    pending: 0,
    quarantined: [],
  })
  local.close()
})

test('retiring a row after its batch is sent does not mark its local snapshot synced', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, undefined, (ordinal) => {
    if (ordinal !== 1) return
    local
      .query(
        `UPDATE outbox SET quarantined_at=?,quarantine_reason='operator review'
         WHERE id=2`,
      )
      .run(STAMP)
    retireOutboxRow(2, 'not deliverable', local, STAMP, 'architect')
  })

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 2,
    failed: 0,
    pending: 0,
  })
  expect(
    remote.statements.filter((statement) => statement.toLowerCase().includes('insert into "run"')),
  ).toHaveLength(2)
  expect(local.query('SELECT synced_at,retired_at FROM outbox WHERE id=2').get()).toEqual({
    synced_at: null,
    retired_at: STAMP,
  })
  local.close()
})

test('a dependent reports a retired parent without attempting delivery', async () => {
  const local = migratedTestDatabase()
  local
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','asking')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES (1,'${newRecordId()}',?,?,'Which?')`,
    )
    .run(RECORD_ID, STAMP)
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  enqueueRunRecord(local, RECORD_ID, MACHINE_ID, STAMP)
  enqueueQuestionRecord(
    local,
    (local.query('SELECT record_id FROM question').get() as { record_id: string }).record_id,
  )
  local
    .query(
      `UPDATE outbox SET quarantined_at=?,quarantine_reason='operator review'
       WHERE kind='run'`,
    )
    .run(STAMP)
  retireOutboxRow(1, 'not deliverable', local, STAMP, 'architect')
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 0,
    pending: 1,
    blocked: [{ id: 2, kind: 'question', parentRecordId: RECORD_ID }],
  })
  expect(
    remote.statements.some((statement) =>
      statement.toLowerCase().includes('insert into "question"'),
    ),
  ).toBe(false)
  local.close()
})

test('a synced parent lets its child flow after a later re-enqueue is retired', async () => {
  const local = localOutbox(3)
  const parent = local
    .query<{ record_id: string; payload: string }, []>(
      'SELECT row_id AS record_id,payload FROM outbox WHERE id=1',
    )
    .get()!
  const child = local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=3').get()!
  local.query('UPDATE outbox SET synced_at=? WHERE id=1').run(STAMP)
  local
    .query(`UPDATE outbox SET row_id=?,retired_at=?,retirement_reason='later snapshot' WHERE id=2`)
    .run(parent.record_id, STAMP)
  local.query('UPDATE outbox SET payload=? WHERE id=3').run(
    JSON.stringify({
      ...JSON.parse(child.payload),
      parentRunId: parent.record_id,
    }),
  )
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 1,
    failed: 0,
    pending: 0,
    blocked: [],
  })
  expect(
    local.query<{ synced_at: string | null }, []>('SELECT synced_at FROM outbox WHERE id=3').get(),
  ).toEqual({ synced_at: STAMP })
  local.close()
})

test('a projectless payload syncs without resolving a project', async () => {
  const local = localOutbox(1, null)
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 1,
    failed: 0,
    pending: 0,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  expect(remote.statements.some((statement) => statement.includes('FROM project'))).toBe(false)
  local.close()
})

test('a payload from another machine is refused before a record write', async () => {
  const local = localOutbox(1)
  const remote = fakePostgres()
  const result = await syncRecord({
    ...options(local, remote),
    identity: {
      id: '01990000-0000-7000-8000-000000000077',
      name: 'other-machine',
    },
  })
  expect(result).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 0,
    configured: true,
  })
  const failure = local
    .query<{ attempts: number; last_error: string }, []>(
      'SELECT attempts, last_error FROM outbox WHERE id=1',
    )
    .get()!
  expect(failure).toEqual({
    attempts: 1,
    last_error: `run outbox machine ${MACHINE_ID} does not match invoking machine 01990000-0000-7000-8000-000000000077`,
  })
  expect(remote.statements.some((statement) => statement.includes('insert into "run"'))).toBe(false)
  local.close()
})

test('every populated JSONB run value is bound as one JSON string', async () => {
  const jsonValues = {
    changedPaths: ['a.ts'],
    docRevisions: [12, 14],
    outsideWorktreeWrites: [{ path: '/tmp/outside' }],
    reviewProvenance: { commands_run: ['bun test'] },
  }
  const local = localOutbox(1, PLATFORM_SLUG, jsonValues)
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 1,
    failed: 0,
    pending: 0,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  const bound = remote.parameters.flat()
  for (const value of Object.values(jsonValues)) expect(bound).toContain(JSON.stringify(value))
  local.close()
})
