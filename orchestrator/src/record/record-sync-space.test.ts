import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { localOutbox, options, RECORD_ID, STAMP } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { applyMigrations } from '../database/migrations.ts'
import { enqueueContention } from './landing-outbox.ts'
import { syncRecord } from './record-sync.ts'

test('declared project spaces override the active space while an unset project falls back', async () => {
  const local = localOutbox(2, 'declared')
  const second = JSON.parse(
    local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=2').get()!.payload,
  ) as Record<string, unknown>
  second.projectName = 'fallback'
  local.query('UPDATE outbox SET payload=? WHERE id=2').run(JSON.stringify(second))
  const remote = fakePostgres()
  const declaredSpace = '01990000-0000-7000-8000-000000000003'
  const memberships = [
    { spaceId: declaredSpace, slug: 'team', permission: 'write' },
    ...options(local, remote).memberships,
  ]
  expect(
    await syncRecord({
      ...options(local, remote, memberships),
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

test("a contention row binds its run project's declared space", async () => {
  const local = new Database(':memory:')
  applyMigrations(local)
  const declaredSpace = '01990000-0000-7000-8000-000000000003'
  local
    .query(
      `INSERT INTO project (record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'declared','/declared',?)`,
    )
    .run(JSON.stringify({ space: 'team' }))
  local
    .query(
      `INSERT INTO run
       (id,record_id,project_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,1,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','ok')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO contention
       (id,record_id,at,resource_kind,resource_key,event_kind,run_id)
       VALUES (1,'01990000-0000-7000-8000-000000000077',?,'lock','resource','wait',42)`,
    )
    .run(STAMP)
  enqueueContention(local, 1, STAMP)
  const remote = fakePostgres()
  const memberships = [
    { spaceId: declaredSpace, slug: 'team', permission: 'write' },
    ...options(local, remote).memberships,
  ]

  expect(await syncRecord(options(local, remote, memberships))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  expect(remote.transactionSpaceIds.at(-1)).toBe(declaredSpace)
  expect(remote.transactionSpaceIds.at(-1)).not.toBe(options(local, remote).principal.spaceId)
  local.close()
})

test("a contention row binds its landing project's declared space", async () => {
  const local = new Database(':memory:')
  applyMigrations(local)
  const declaredSpace = '01990000-0000-7000-8000-000000000003'
  local
    .query(
      `INSERT INTO project (record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'declared','/declared',?)`,
    )
    .run(JSON.stringify({ space: 'team' }))
  local
    .query(
      `INSERT INTO landing (id,record_id,project,project_id,branch,status,started_at)
       VALUES (42,?, 'declared',1,'DEV-1367','landed','2026-09-16T00:00:00.000Z')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO contention
       (id,record_id,at,resource_kind,resource_key,event_kind,landing_id)
       VALUES (1,'01990000-0000-7000-8000-000000000077',?,'lock','resource','wait',42)`,
    )
    .run(STAMP)
  enqueueContention(local, 1, STAMP)
  const remote = fakePostgres()
  const memberships = [
    { spaceId: declaredSpace, slug: 'team', permission: 'write' },
    ...options(local, remote).memberships,
  ]

  expect(await syncRecord(options(local, remote, memberships))).toMatchObject({
    pushed: 1,
    failed: 0,
  })
  expect(remote.transactionSpaceIds.at(-1)).toBe(declaredSpace)
  expect(remote.transactionSpaceIds.at(-1)).not.toBe(options(local, remote).principal.spaceId)
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
  const memberships = [
    { spaceId: alpha, slug: 'alpha', permission: 'write' },
    { spaceId: beta, slug: 'beta', permission: 'write' },
    ...options(local, remote).memberships,
  ]
  expect(
    await syncRecord({
      ...options(local, remote, memberships),
      projectSpaces: { alpha: 'alpha', beta: 'beta' },
    }),
  ).toMatchObject({ pushed: 2, failed: 0 })
  expect(remote.transactionSpaceIds.filter((id) => id === alpha)).toHaveLength(1)
  expect(remote.transactionSpaceIds.filter((id) => id === beta)).toHaveLength(1)
  local.close()
})

test('a read-only destination is deferred per row and retried after permission changes', async () => {
  // Production break watched: classify the read-only refusal as row-fatal and quarantine it.
  const local = localOutbox(2, 'read-only-project')
  const second = JSON.parse(
    local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=2').get()!.payload,
  ) as Record<string, unknown>
  second.projectName = 'write-project'
  local.query('UPDATE outbox SET payload=? WHERE id=2').run(JSON.stringify(second))
  const remote = fakePostgres()
  const readOnlySpace = '01990000-0000-7000-8000-000000000003'
  const baseMemberships = options(local, remote).memberships
  const projectSpaces = {
    'read-only-project': 'read-only-space',
    'write-project': 'platform',
  }

  expect(
    await syncRecord({
      ...options(local, remote, [
        { spaceId: readOnlySpace, slug: 'read-only-space', permission: 'read' },
        ...baseMemberships,
      ]),
      projectSpaces,
    }),
  ).toMatchObject({
    pushed: 1,
    failed: 0,
    pending: 1,
    quarantined: [],
    readOnlyDeferred: [{ spaceId: readOnlySpace, rows: 1 }],
  })
  expect(
    local
      .query<{ attempts: number; last_error: string; quarantined_at: string | null }, []>(
        'SELECT attempts,last_error,quarantined_at FROM outbox WHERE id=1',
      )
      .get(),
  ).toEqual({
    attempts: 1,
    last_error: expect.stringContaining(`record space ${readOnlySpace} membership is read-only`),
    quarantined_at: null,
  })

  expect(
    await syncRecord({
      ...options(local, remote, [
        {
          spaceId: readOnlySpace,
          slug: 'read-only-space',
          permission: 'write',
        },
        ...baseMemberships,
      ]),
      projectSpaces,
    }),
  ).toMatchObject({ pushed: 1, failed: 0, pending: 0, quarantined: [] })
  local.close()
})
