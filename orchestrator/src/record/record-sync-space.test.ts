import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { localOutbox, options, RECORD_ID, STAMP } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { applyMigrations } from '../database/migrations.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { enqueueContention } from './landing-outbox.ts'
import { syncRecord } from './record-sync.ts'

test('project-owned evidence uses its declared space while the active space is personal', async () => {
  const local = migratedTestDatabase()
  const rows = [
    { kind: 'run', id: 'run-1' },
    { kind: 'score', id: 'run-1' },
    { kind: 'review', id: 'review-1' },
    { kind: 'contention', id: 'contention-1' },
  ]
  for (const [index, row] of rows.entries()) {
    local
      .query(
        'INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        newRecordId(),
        index + 1,
        row.kind,
        row.id,
        JSON.stringify({ id: row.id, projectId: 'project-1', projectName: 'declared' }),
        STAMP,
      )
  }
  const personal = '01990000-0000-7000-8000-000000000010'
  const team = '01990000-0000-7000-8000-000000000011'
  const hints: Array<string | null> = []

  expect(
    await syncRecord({
      local,
      projectSpaces: { declared: 'team' },
      identity: { id: '01990000-0000-7000-8000-000000000012', name: 'test-machine' },
      client: {
        whoami: async () => ({
          user: { id: '01990000-0000-7000-8000-000000000013' },
          activeSpaceId: personal,
          personalSpaceId: personal,
          memberships: [
            { space_id: personal, slug: 'personal', permission: 'write' },
            { space_id: team, slug: 'team', permission: 'write' },
          ],
        }),
        sync: async (request) => {
          hints.push(...request.rows.map((row) => row.spaceHint))
          return {
            results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
          }
        },
      },
    }),
  ).toMatchObject({ pushed: 4, pending: 0 })
  expect(hints).toEqual([team, team, team, team])
  local.close()
})

test('declared project spaces override the active space while an unset project stays pending', async () => {
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
    pushed: 1,
    failed: 0,
    pending: 1,
    configured: true,
    quarantined: [],
    blocked: [],
    routingHeld: [
      {
        id: 2,
        kind: 'run',
        reason: expect.stringContaining('project fallback has no declared record space'),
      },
    ],
  })
  expect(remote.transactionSpaceIds).toContain(declaredSpace)
  local.close()
})

test('a project space outside the signed-in memberships stays pending', async () => {
  const local = localOutbox(1, 'declared')
  const remote = fakePostgres()

  expect(
    await syncRecord({
      ...options(local, remote),
      projectSpaces: { declared: 'outside' },
    }),
  ).toMatchObject({
    pushed: 0,
    failed: 0,
    pending: 1,
    quarantined: [],
    routingHeld: [
      {
        id: 1,
        kind: 'run',
        reason: expect.stringContaining('not a member of record space outside'),
      },
    ],
  })
  expect(local.query('SELECT synced_at,quarantined_at,attempts FROM outbox').get()).toEqual({
    synced_at: null,
    quarantined_at: null,
    attempts: 0,
  })
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
       (number,record_id,project_record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,(SELECT record_id FROM project WHERE name='declared'),'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','ok')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO contention
       (record_id,at,resource_kind,resource_key,event_kind,run_record_id)
       VALUES ('01990000-0000-7000-8000-000000000077',?,'lock','resource','wait',?)`,
    )
    .run(STAMP, RECORD_ID)
  enqueueContention(local, '01990000-0000-7000-8000-000000000077', STAMP)
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
      `INSERT INTO landing (record_id,project,project_record_id,branch,status,started_at)
       VALUES (?,'declared',(SELECT record_id FROM project WHERE name='declared'),'DEV-1367','landed','2026-09-16T00:00:00.000Z')`,
    )
    .run(RECORD_ID)
  local
    .query(
      `INSERT INTO contention
       (record_id,at,resource_kind,resource_key,event_kind,landing_record_id)
       VALUES ('01990000-0000-7000-8000-000000000077',?,'lock','resource','wait',?)`,
    )
    .run(STAMP, RECORD_ID)
  enqueueContention(local, '01990000-0000-7000-8000-000000000077', STAMP)
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
