import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { WITHHELD_SECRET_SHAPED } from '../../../shared/secret-shaped.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { applyMigrations } from '../database/migrations.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { enqueueScoreRecord } from '../score/score-outbox.ts'
import { syncRecord } from './record-sync.ts'
import { syncHostedRecord } from './record-sync-service.ts'

const RECORD_ID = '01990000-0000-7000-8000-000000000042'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const STAMP = '2026-09-15T01:01:00.000Z'

function localScoreOutbox(): Database {
  const local = new Database(':memory:')
  applyMigrations(local)
  fixtureProjectRecordId(local)
  local
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','file-question','sha',3,'ask','ok',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(RECORD_ID)
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

const options = (local: Database, remote: ReturnType<typeof fakePostgres>) => ({
  local,
  now: () => STAMP,
  identity: { id: MACHINE_ID, name: 'test-machine' },
  principal: {
    userId: '01990000-0000-7000-8000-000000000002',
    spaceId: '01990000-0000-7000-8000-000000000001',
  },
  memberships: [
    {
      spaceId: '01990000-0000-7000-8000-000000000001',
      slug: 'active',
      permission: 'write',
    },
  ],
  client: {
    whoami: async () => ({
      user: { id: '01990000-0000-7000-8000-000000000002' },
      activeSpaceId: '01990000-0000-7000-8000-000000000001',
      personalSpaceId: '01990000-0000-7000-8000-000000000001',
      memberships: [
        { space_id: '01990000-0000-7000-8000-000000000001', slug: 'active', permission: 'write' },
      ],
    }),
    sync: (request: Parameters<typeof syncHostedRecord>[0]['request']) =>
      syncHostedRecord({
        url: 'postgres://record.test/database',
        identity: {
          user: { id: '01990000-0000-7000-8000-000000000002' },
          activeSpaceId: '01990000-0000-7000-8000-000000000001',
          personalSpaceId: '01990000-0000-7000-8000-000000000001',
          memberships: [
            {
              space_id: '01990000-0000-7000-8000-000000000001',
              slug: 'active',
              permission: 'write',
            },
          ],
        },
        request,
        postgres: remote.sql,
      }),
  },
})

test('a grade-less legacy review score replaces its hosted note when its axes are unchanged', async () => {
  const local = localScoreOutbox()
  const row = local.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  payload.note = WITHHELD_SECRET_SHAPED
  local.query('UPDATE outbox SET payload=?').run(JSON.stringify(payload))
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, {
    job: 'review-lens',
    writesRepo: false,
    findings: true,
    hostedAxes: { delivery: 'full', quality: 'right', fidelity: null },
  })

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 1, failed: 0 })
  expect(remote.parameters.flat()).toContain(WITHHELD_SECRET_SHAPED)
  expect(
    remote.statements.some((sql) => sql.toLowerCase().includes('insert into "run_score"')),
  ).toBe(true)
  local.close()
})

test('a grade-less legacy review score with no hosted row is still refused', async () => {
  const local = localScoreOutbox()
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, {
    job: 'review-lens',
    writesRepo: false,
    findings: true,
  })

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 0, failed: 1 })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toContain('findings-producing jobs require reproduced, coverage, limits, and overlap')
  local.close()
})

test('a grade-less legacy review score whose hosted axes differ is still refused', async () => {
  const local = localScoreOutbox()
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, {
    job: 'review-lens',
    writesRepo: false,
    findings: true,
    hostedAxes: { delivery: 'partial', quality: 'right', fidelity: null },
  })

  expect(await syncRecord(options(local, remote))).toMatchObject({ pushed: 0, failed: 1 })
  expect(
    local.query<{ last_error: string }, []>('SELECT last_error FROM outbox').get()!.last_error,
  ).toContain('findings-producing jobs require reproduced, coverage, limits, and overlap')
  local.close()
})
