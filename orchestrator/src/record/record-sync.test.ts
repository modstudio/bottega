import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from '../../../shared/record/schema.ts'
import { applyMigrations } from '../database/migrations.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { enqueueRunRecord, RUN_RECORD_PAYLOAD_COLUMNS } from '../run/run-outbox.ts'
import { enqueueScoreRecord } from '../score/score-outbox.ts'
import { LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS } from './landing-outbox.ts'
import { retireOutboxRow, retryOutboxRow } from './outbox-quarantine.ts'
import { outboxOrder, syncRecord, unreachableSpaceProject } from './record-sync.ts'

const RECORD_ID = '01990000-0000-7000-8000-000000000042'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const PROJECT_ID = '01990000-0000-7000-8000-000000000088'
const STAMP = '2026-09-15T01:01:00.000Z'

test('outbox ordering sends run rows before run-dependent rows', () => {
  const rows = [
    { kind: 'question', id: 21647 },
    { kind: 'score', id: 21649 },
    { kind: 'run', id: 21650 },
    { kind: 'landing', id: 21648 },
    { kind: 'review', id: 21651 },
    { kind: 'run', id: 21652 },
    { kind: 'review_lens', id: 21653 },
    { kind: 'review_finding', id: 21654 },
    { kind: 'contention', id: 21655 },
    { kind: 'test_flake', id: 21656 },
  ]

  const ordered = rows.toSorted((left, right) => {
    const [leftPhase, leftId] = outboxOrder(left.kind, left.id)
    const [rightPhase, rightId] = outboxOrder(right.kind, right.id)
    return leftPhase - rightPhase || leftId - rightId
  })

  expect(ordered).toEqual([
    { kind: 'run', id: 21650 },
    { kind: 'run', id: 21652 },
    { kind: 'landing', id: 21648 },
    { kind: 'test_flake', id: 21656 },
    { kind: 'question', id: 21647 },
    { kind: 'score', id: 21649 },
    { kind: 'review', id: 21651 },
    { kind: 'review_lens', id: 21653 },
    { kind: 'review_finding', id: 21654 },
    { kind: 'contention', id: 21655 },
  ])
})

type HostedExclusion = {
  rowReason: string | null
  supersededAt: string | null
  runReason: string | null
}

function hostedExclusionResult(
  source: string,
  hostedExclusion: HostedExclusion,
): Record<string, unknown>[] | null {
  if (source.includes('SELECT reason FROM run_exclusion') && source.includes('superseded_at')) {
    if (hostedExclusion.rowReason === null || hostedExclusion.supersededAt !== null) return []
    return [{ reason: hostedExclusion.rowReason }]
  }
  if (source.includes('SELECT evidence_excluded FROM run')) {
    return [{ evidence_excluded: hostedExclusion.runReason }]
  }
  return null
}

function localOutbox(
  count: number,
  projectName: string | null = PLATFORM_SLUG,
  overrides: Record<string, unknown> = {},
): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT, retirement_reason TEXT
  );
  CREATE TABLE outbox_quarantine_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
    error TEXT, attempts INTEGER NOT NULL, disposition TEXT NOT NULL, actor_session TEXT,
    at TEXT NOT NULL, reason TEXT
  )`)
  for (let id = 1; id <= count; id++) {
    const values = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
    Object.assign(values, {
      id: `${RECORD_ID.slice(0, -1)}${id}`,
      spaceId: '01990000-0000-7000-8000-000000000001',
      projectName,
      machineId: MACHINE_ID,
      localId: id,
      startedAt: STAMP,
      finishedAt: STAMP,
      agent: 'codex',
      job: 'probe',
      promptSha: 'prompt',
      promptBytes: 6,
      promptHead: 'prompt',
      probe: true,
      status: 'ok',
      turn: 1,
      noFailover: false,
      automaticFailover: false,
      workPreserved: false,
      createdAt: STAMP,
      updatedAt: STAMP,
      ...overrides,
    })
    local
      .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (?,'run',?,?,?)")
      .run(id, values.id ?? null, JSON.stringify(values), STAMP)
  }
  return local
}

function localTriageSnapshotOutbox(mutate: (payload: Record<string, unknown>) => void): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT
  )`)
  const payload = Object.fromEntries(
    LANDING_TRIAGE_SNAPSHOT_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]),
  )
  Object.assign(payload, {
    id: RECORD_ID,
    spaceId: '01990000-0000-7000-8000-000000000001',
    projectName: PLATFORM_SLUG,
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
      "INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (1,'landing_triage_snapshot',?,?,?)",
    )
    .run(RECORD_ID, JSON.stringify(payload), STAMP)
  return local
}

function fakePostgres(
  failFirstRun: false | Error = false,
  principal: string = RECORD_ACTOR_ROLE,
  score?: {
    job: string
    writesRepo: boolean
    findings: boolean
    onWrite?: () => void
  },
  hostedExclusion: HostedExclusion = {
    rowReason: 'voided with orch score --void',
    supersededAt: null,
    runReason: 'voided with orch score --void',
  },
  onRunWrite?: (ordinal: number) => void | Promise<void>,
): {
  sql: SQL
  statements: string[]
  parameters: unknown[][]
  transactionSpaceIds: string[]
} {
  const statements: string[] = []
  const parameters: unknown[][] = []
  let failed = false
  let transaction = -1
  let scoreWritten = false
  let runWrites = 0
  const transactionSpaceIds: string[] = []
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const source = parts.join('?')
    statements.push(source)
    if (source.includes("set_config('app.space_id'")) {
      transactionSpaceIds[transaction] = String(values[0])
    }
    if (source.includes('SELECT job, failure_kind, machine_id FROM run')) {
      return [{ job: score?.job ?? 'file-question', failure_kind: null, machine_id: MACHINE_ID }]
    }
    if (source.includes("snapshot.kind='jobs'")) {
      return score
        ? [
            {
              item: {
                name: score.job,
                needs: { writesRepo: score.writesRepo },
                findings: score.findings,
              },
            },
          ]
        : []
    }
    if (source.includes('information_schema.columns')) {
      return [
        { column_name: 'superseded_at' },
        { column_name: 'superseded_by' },
        { column_name: 'supersede_note' },
      ]
    }
    const exclusionResult = hostedExclusionResult(source, hostedExclusion)
    if (exclusionResult) return exclusionResult
    if (source.includes('SELECT reason FROM run_exclusion')) return []
    return source.includes('SELECT id FROM project') ? [{ id: PROJECT_ID }] : []
  }) as unknown as SQL
  tx.options = {} as SQL['options']
  tx.unsafe = (async (source: string, values?: unknown[]) => {
    statements.push(source)
    parameters.push(values ?? [])
    if (source.toLowerCase().includes('insert into "run"')) {
      runWrites++
      await onRunWrite?.(runWrites)
    }
    if (failFirstRun && !failed && source.toLowerCase().includes('insert into "run"')) {
      failed = true
      throw failFirstRun
    }
    if (!scoreWritten && source.toLowerCase().includes('insert into "run_score"')) {
      scoreWritten = true
      score?.onWrite?.()
    }
    return []
  }) as SQL['unsafe']
  const sql = Object.assign(
    async (parts: TemplateStringsArray) => {
      statements.push(parts.join('?'))
      return [{ principal }]
    },
    {
      begin: async (operation: (client: SQL) => unknown) => {
        transaction++
        return operation(tx)
      },
      close: async () => {},
    },
  ) as unknown as SQL
  return { sql, statements, parameters, transactionSpaceIds }
}

const serverError = (message: string, errno: number) =>
  new SQL.PostgresError(message, {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: errno as unknown as string,
  })

function localScoreOutbox(): Database {
  const local = new Database(':memory:')
  applyMigrations(local)
  local
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','ok')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO score
       (run_id,delivery,quality,fidelity,note,scored_at,scored_by)
       VALUES (42,'full','right',NULL,'old',?,'architect')`,
    )
    .run(STAMP)
  enqueueScoreRecord(local, 42, MACHINE_ID)
  return local
}

const options = (local: Database, remote: ReturnType<typeof fakePostgres>) => ({
  recordUrl: 'postgres://record.test/database',
  local,
  openSql: () => remote.sql,
  now: () => STAMP,
  identity: { id: MACHINE_ID, name: 'test-machine' },
  principal: {
    userId: '01990000-0000-7000-8000-000000000002',
    spaceId: '01990000-0000-7000-8000-000000000001',
  },
})

test('sync upserts once and a second pass has no run mutation', async () => {
  const local = localOutbox(1)
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

test('ordinary sync pushes an asking run before its live question', async () => {
  const local = new Database(':memory:')
  applyMigrations(local)
  local
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','asking')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO question (run_id,asked_at,question,asked_via)
       VALUES (42,?,'Which?','live')`,
    )
    .run(STAMP)
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  enqueueRunRecord(local, 42, MACHINE_ID, STAMP)
  enqueueQuestionRecord(local, 1)

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
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
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
    runReason: 'voided with orch score --void',
  })
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
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
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
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
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 0, failed: 1 })
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
      local.query("UPDATE score SET note='new', scored_at=? WHERE run_id=42").run(newerStamp)
      enqueueScoreRecord(local, 42, MACHINE_ID)
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
    local.query<{ synced_at: string | null }, []>('SELECT synced_at FROM outbox').get()!.synced_at,
  ).toBeNull()
  expect(
    JSON.parse(local.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!.payload),
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
  const row = local.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  mutate(payload)
  local.query('UPDATE outbox SET payload=?').run(JSON.stringify(payload))
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, job)

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 0,
    configured: true,
  })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toContain(message)
  expect(
    remote.statements.some((sql) => sql.toLowerCase().includes('insert into "run_score"')),
  ).toBe(false)
  local.close()
})

test('a pre-attribution run payload stays null instead of borrowing the pushing user', async () => {
  const local = localOutbox(1)
  const row = local.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  delete payload.startedByUserId
  delete payload.taskKey
  local.query('UPDATE outbox SET payload=?').run(JSON.stringify(payload))
  const remote = fakePostgres()
  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  expect(remote.parameters.flat()).toContain(null)
  local.close()
})

test('an old-shape triage snapshot syncs with declared fills and keeps its override', async () => {
  const local = localTriageSnapshotOutbox((payload) => {
    delete payload.admissionPath
    delete payload.readId
  })
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  const values = remote.parameters.find((parameters) => parameters.includes('override-record'))
  expect(values).toContain('exact_review')
  expect(values).toContain(null)
  local.close()
})

test.each([
  {
    name: 'an unexpected extra column',
    mutate: (payload: Record<string, unknown>) => Object.assign(payload, { unexpected: null }),
  },
  {
    name: 'a missing required column',
    mutate: (payload: Record<string, unknown>) => {
      delete payload.branch
    },
  },
])('triage snapshot sync refuses $name', async ({ mutate }) => {
  const local = localTriageSnapshotOutbox(mutate)
  const remote = fakePostgres()

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 0, failed: 1 })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toBe('landing_triage_snapshot outbox payload has an unexpected column set')
  local.close()
})

test('sync refuses the migration owner before any record write', async () => {
  const local = localOutbox(1)
  const remote = fakePostgres(false, RECORD_OWNER_ROLE)
  await expect(syncRecord(options(local, remote))).rejects.toThrow(
    `record sync refuses ${RECORD_OWNER_ROLE} credentials; set ORCH_RECORD_URL to the ${RECORD_ACTOR_ROLE} connection`,
  )
  expect(remote.statements).toEqual(['SELECT current_user AS principal'])
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

test('a pass-fatal failure records its attempt and stops before the next row', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(
    new SQL.PostgresError('connection refused', { code: 'ERR_POSTGRES_CONNECTION_REFUSED' }),
  )
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 2,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  const rows = local
    .query<{ attempts: number; quarantined_at: string | null }, []>(
      'SELECT attempts,quarantined_at FROM outbox ORDER BY id',
    )
    .all()
  expect(rows).toEqual([
    { attempts: 1, quarantined_at: null },
    { attempts: 0, quarantined_at: null },
  ])
  local.close()
})

test('a revoked table grant is pass-fatal and stops before the next row', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(serverError('permission denied for table run', 42501))

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 2,
    quarantined: [],
  })
  expect(local.query('SELECT attempts FROM outbox ORDER BY id').all()).toEqual([
    { attempts: 1 },
    { attempts: 0 },
  ])
  local.close()
})

test('a quarantined parent defers its graph until retry delivers the parent', async () => {
  const local = new Database(':memory:')
  applyMigrations(local)
  local
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','asking')`,
    )
    .run(RECORD_ID)
  local.query("INSERT INTO question (run_id,asked_at,question) VALUES (42,?,'Which?')").run(STAMP)
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  enqueueRunRecord(local, 42, MACHINE_ID, STAMP)
  enqueueQuestionRecord(local, 1)
  const remote = fakePostgres(
    serverError('new row violates row-level security policy for table "run"', 42501),
  )

  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 0,
    failed: 1,
    pending: 1,
    quarantined: [{ id: 1, kind: 'run' }],
  })
  expect(local.query('SELECT attempts,quarantined_at FROM outbox WHERE id=2').get()).toEqual({
    attempts: 0,
    quarantined_at: null,
  })

  retryOutboxRow(1, local, STAMP, 'architect')
  expect(await syncRecord(options(local, remote))).toMatchObject({
    pushed: 2,
    failed: 0,
    pending: 0,
    quarantined: [],
  })
  local.close()
})

test('retiring a later row after the snapshot prevents its delivery', async () => {
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
    pushed: 1,
    failed: 0,
    pending: 0,
  })
  expect(
    remote.statements.filter((statement) => statement.toLowerCase().includes('insert into "run"')),
  ).toHaveLength(1)
  expect(local.query('SELECT synced_at,retired_at FROM outbox WHERE id=2').get()).toEqual({
    synced_at: null,
    retired_at: STAMP,
  })
  local.close()
})

test('a dependent reports a retired parent without attempting delivery', async () => {
  const local = new Database(':memory:')
  applyMigrations(local)
  local
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','asking')`,
    )
    .run(RECORD_ID)
  local.query("INSERT INTO question (run_id,asked_at,question) VALUES (42,?,'Which?')").run(STAMP)
  local
    .query("INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run(MACHINE_ID)
  enqueueRunRecord(local, 42, MACHINE_ID, STAMP)
  enqueueQuestionRecord(local, 1)
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
  expect(remote.statements.some((statement) => statement.includes('SELECT id FROM project'))).toBe(
    false,
  )
  local.close()
})

test('a payload from another machine is refused before a record write', async () => {
  const local = localOutbox(1)
  const remote = fakePostgres()
  const result = await syncRecord({
    ...options(local, remote),
    identity: { id: '01990000-0000-7000-8000-000000000077', name: 'other-machine' },
  })
  expect(result).toMatchObject({ pushed: 0, failed: 1, pending: 0, configured: true })
  const failure = local
    .query<{ attempts: number; last_error: string }, []>(
      'SELECT attempts, last_error FROM outbox WHERE id=1',
    )
    .get()!
  expect(failure).toEqual({
    attempts: 1,
    last_error:
      'run outbox machine 01990000-0000-7000-8000-000000000099 does not match invoking machine 01990000-0000-7000-8000-000000000077',
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

test('declared project spaces override the active space while an unset project falls back', async () => {
  const local = localOutbox(2, 'declared')
  const second = JSON.parse(
    local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=2').get()!.payload,
  ) as Record<string, unknown>
  second.projectName = 'fallback'
  local.query('UPDATE outbox SET payload=? WHERE id=2').run(JSON.stringify(second))
  const remote = fakePostgres()
  const declaredSpace = '01990000-0000-7000-8000-000000000003'
  expect(
    await syncRecord({
      ...options(local, remote),
      memberships: [{ spaceId: declaredSpace, slug: 'team' }],
      projectSpaces: { declared: 'team' },
    }),
  ).toEqual({
    pushed: 2,
    failed: 0,
    pending: 0,
    configured: true,
    quarantined: [],
    blocked: [],
  })
  expect(remote.transactionSpaceIds).toContain(declaredSpace)
  expect(remote.transactionSpaceIds).toContain(options(local, remote).principal.spaceId)
  local.close()
})

test('two declared projects bind their own spaces in separate transactions', async () => {
  const local = localOutbox(2, 'alpha')
  const second = JSON.parse(
    local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=2').get()!.payload,
  ) as Record<string, unknown>
  second.projectName = 'beta'
  local.query('UPDATE outbox SET payload=? WHERE id=2').run(JSON.stringify(second))
  const remote = fakePostgres()
  const alpha = '01990000-0000-7000-8000-000000000003'
  const beta = '01990000-0000-7000-8000-000000000004'
  expect(
    await syncRecord({
      ...options(local, remote),
      memberships: [
        { spaceId: alpha, slug: 'alpha' },
        { spaceId: beta, slug: 'beta' },
      ],
      projectSpaces: { alpha: 'alpha', beta: 'beta' },
    }),
  ).toMatchObject({ pushed: 2, failed: 0 })
  expect(remote.transactionSpaceIds.filter((id) => id === alpha)).toHaveLength(1)
  expect(remote.transactionSpaceIds.filter((id) => id === beta)).toHaveLength(1)
  local.close()
})
