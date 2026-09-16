import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from './postgres-schema.ts'
import { syncRecord } from './record-sync.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from './run-outbox.ts'

const RECORD_ID = '01990000-0000-7000-8000-000000000042'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const PROJECT_ID = '01990000-0000-7000-8000-000000000088'
const STAMP = '2026-09-15T01:01:00.000Z'

function localOutbox(
  count: number,
  projectName: string | null = PLATFORM_SLUG,
  overrides: Record<string, unknown> = {},
): Database {
  const local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT
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

function fakePostgres(
  failFirstRun = false,
  principal: string = RECORD_ACTOR_ROLE,
): {
  sql: SQL
  statements: string[]
  parameters: unknown[][]
} {
  const statements: string[] = []
  const parameters: unknown[][] = []
  let failed = false
  const tx = (async (parts: TemplateStringsArray) => {
    const source = parts.join('?')
    statements.push(source)
    return source.includes('SELECT id FROM project') ? [{ id: PROJECT_ID }] : []
  }) as unknown as SQL
  tx.options = {} as SQL['options']
  tx.unsafe = (async (source: string, values?: unknown[]) => {
    statements.push(source)
    parameters.push(values ?? [])
    if (failFirstRun && !failed && source.toLowerCase().includes('insert into "run"')) {
      failed = true
      throw Object.assign(new Error('remote run refusal'), { code: '23503' })
    }
    return []
  }) as SQL['unsafe']
  const sql = Object.assign(
    async (parts: TemplateStringsArray) => {
      statements.push(parts.join('?'))
      return [{ principal }]
    },
    {
      begin: async (operation: (client: SQL) => unknown) => operation(tx),
      close: async () => {},
    },
  ) as unknown as SQL
  return { sql, statements, parameters }
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
  })
  const firstRunWrites = remote.statements.filter((sql) =>
    sql.toLowerCase().includes('insert into "run"'),
  ).length
  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 0,
    failed: 0,
    pending: 0,
    configured: true,
  })
  expect(
    remote.statements.filter((sql) => sql.toLowerCase().includes('insert into "run"')),
  ).toHaveLength(firstRunWrites)
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

test('a failed row records its attempt and stops before the next row', async () => {
  const local = localOutbox(2)
  const remote = fakePostgres(true)
  expect(await syncRecord(options(local, remote))).toEqual({
    pushed: 0,
    failed: 1,
    pending: 2,
    configured: true,
  })
  const rows = local.query('SELECT attempts, last_error FROM outbox ORDER BY id').all() as {
    attempts: number
    last_error: string | null
  }[]
  expect(rows.map((row) => row.attempts)).toEqual([1, 0])
  expect(rows[0]!.last_error).toContain('Failed query: insert into "run"')
  expect(rows[0]!.last_error).toContain('[23503] remote run refusal')
  expect(rows[1]!.last_error).toBeNull()
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
  expect(result).toEqual({ pushed: 0, failed: 1, pending: 1, configured: true })
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
  })
  const bound = remote.parameters.flat()
  for (const value of Object.values(jsonValues)) expect(bound).toContain(JSON.stringify(value))
  local.close()
})
