import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { backfillLandingEvidenceRecords } from './landing-outbox.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'

const LANDING_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.landing.columns
const LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.landing_override.columns
const LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS =
  OUTBOX_PAYLOAD_CONTRACTS.landing_review_carry.columns
const CONTENTION_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.contention.columns
const TEST_FLAKE_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.test_flake.columns

test('landing evidence backfill enqueues references in order, maps every column, and is idempotent', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  fixtureProjectRecordId(database)
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id','machine-record')").run()
  database
    .query(`INSERT INTO run
      (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
      VALUES (1,'run-record','2026-09-15T00:00:00Z','codex','test','sha',1,'head','ok',
              (SELECT record_id FROM project ORDER BY name LIMIT 1))`)
    .run()
  database
    .query(
      "INSERT INTO review (number,record_id,recorded_at) VALUES (1,'review-record','2026-09-15T00:01:00Z')",
    )
    .run()
  database
    .query(`INSERT INTO landing
      (record_id,project,branch,tip,trunk_before,status,error,session_id,started_at,finished_at,
       heartbeat_delivered_at,path_set,requested_at,steps,claim_pid,claim_session)
      VALUES ('01990000-0000-7000-8000-000000000021','fixture','DEV-1','tip','trunk','landed',NULL,
       'session','2026-09-15T00:02:00Z','2026-09-15T00:03:00Z','2026-09-15T00:04:00Z','["a.ts"]',
       '2026-09-15T00:01:00Z','["gate"]',42,'claim')`)
    .run()
  database
    .query(`INSERT INTO landing
      (record_id,project,branch,status,started_at,causing_landing_record_id)
      VALUES ('01990000-0000-7000-8000-000000000022','fixture','DEV-2','refused',
       '2026-09-15T00:05:00Z','01990000-0000-7000-8000-000000000021')`)
    .run()
  database
    .query(`INSERT INTO landing_override
      (record_id,project,branch,tip,tree,patch_id,path_set,reason,session_id,at)
      VALUES ('01990000-0000-7000-8000-000000000023','fixture','DEV-1','tip','tree','patch',
       '["a.ts"]','reason','session','2026-09-15T00:06:00Z')`)
    .run()
  database
    .query(`INSERT INTO landing_review_carry
      (record_id,project,branch,tip,tree,review_record_id,reviewed_commit,reviewed_tree,patch_id,
       old_base,new_base,session_id,at)
      VALUES ('01990000-0000-7000-8000-000000000024','fixture','DEV-1','tip','tree','review-record','commit',
       'reviewed-tree','patch','old','new','session','2026-09-15T00:07:00Z')`)
    .run()
  database
    .query(`INSERT INTO contention
      (record_id,at,session_id,resource_kind,resource_key,event_kind,duration_ms,cause,run_record_id,landing_record_id)
      VALUES ('01990000-0000-7000-8000-000000000025','2026-09-15T00:08:00Z','session','lock',
       'resource','wait',12,'cause','run-record','01990000-0000-7000-8000-000000000021')`)
    .run()
  database
    .query(`INSERT INTO test_flake
      (record_id,test,file,load_at_failure,signal,at)
      VALUES ('01990000-0000-7000-8000-000000000026','test name','test.ts','{"load":1}','SIGTERM',
       '2026-09-15T00:09:00Z')`)
    .run()

  expect(backfillLandingEvidenceRecords(database)).toEqual({
    enqueuedLandings: 2,
    enqueuedOverrides: 1,
    enqueuedCarries: 1,
    enqueuedTriageSnapshots: 0,
    enqueuedContentions: 1,
    enqueuedFlakes: 1,
    enqueuedPullRequestCi: 0,
  })
  const rows = database
    .query<{ kind: string; payload: string }, []>('SELECT kind,payload FROM outbox ORDER BY id')
    .all()
  expect(rows.map((row) => row.kind)).toEqual([
    'landing',
    'landing',
    'landing_override',
    'landing_review_carry',
    'contention',
    'test_flake',
  ])
  const expectedColumns = [
    LANDING_RECORD_PAYLOAD_COLUMNS,
    LANDING_RECORD_PAYLOAD_COLUMNS,
    LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS,
    LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS,
    CONTENTION_RECORD_PAYLOAD_COLUMNS,
    TEST_FLAKE_RECORD_PAYLOAD_COLUMNS,
  ]
  rows.forEach((row, index) => {
    expect(Object.keys(JSON.parse(row.payload)).sort()).toEqual([...expectedColumns[index]!].sort())
  })
  const firstLanding = JSON.parse(rows[0]!.payload)
  expect(firstLanding).not.toHaveProperty('claimPid')
  expect(firstLanding).not.toHaveProperty('claimSession')
  expect(firstLanding).not.toHaveProperty('heartbeatDeliveredAt')
  expect(JSON.parse(rows[1]!.payload).causingLandingId).toBe(firstLanding.id)
  expect(JSON.parse(rows[2]!.payload).pathSet).toEqual(['a.ts'])
  expect(JSON.parse(rows[3]!.payload).reviewId).toBe('review-record')
  expect(JSON.parse(rows[4]!.payload)).toMatchObject({
    runId: 'run-record',
    landingId: firstLanding.id,
  })
  expect(JSON.parse(rows[5]!.payload).projectName).toBeNull()

  expect(backfillLandingEvidenceRecords(database)).toEqual({
    enqueuedLandings: 0,
    enqueuedOverrides: 0,
    enqueuedCarries: 0,
    enqueuedTriageSnapshots: 0,
    enqueuedContentions: 0,
    enqueuedFlakes: 0,
    enqueuedPullRequestCi: 0,
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(6)
  database.close()
})
