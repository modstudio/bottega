import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { syncRecord } from './record-sync.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from './run-outbox.ts'

const RECORD_ID = '01990000-0000-7000-8000-000000000042'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const PROJECT_ID = '01990000-0000-7000-8000-000000000088'
const STAMP = '2026-09-15T01:01:00.000Z'

function localOutbox(count: number): Database {
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
      projectName: PLATFORM_SLUG,
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
    })
    local
      .query("INSERT INTO outbox (id,kind,record_id,payload,created_at) VALUES (?,'run',?,?,?)")
      .run(id, values.id, JSON.stringify(values), STAMP)
  }
  return local
}

function fakePostgres(failFirstRun = false): { sql: SQL; statements: string[] } {
  const statements: string[] = []
  let failed = false
  const tx = (async (parts: TemplateStringsArray) => {
    const source = parts.join('?')
    statements.push(source)
    return source.includes('SELECT id FROM project') ? [{ id: PROJECT_ID }] : []
  }) as unknown as SQL
  tx.options = {} as SQL['options']
  tx.unsafe = (async (source: string) => {
    statements.push(source)
    if (failFirstRun && !failed && source.toLowerCase().includes('insert into "run"')) {
      failed = true
      throw new Error('remote run refusal')
    }
    return []
  }) as SQL['unsafe']
  const sql = {
    begin: async (operation: (client: SQL) => unknown) => operation(tx),
    close: async () => {},
  } as unknown as SQL
  return { sql, statements }
}

const options = (local: Database, remote: ReturnType<typeof fakePostgres>) => ({
  recordUrl: 'postgres://record.test/database',
  local,
  openSql: () => remote.sql,
  now: () => STAMP,
  identity: { id: MACHINE_ID, name: 'test-machine' },
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
  expect(rows[1]!.last_error).toBeNull()
  local.close()
})
