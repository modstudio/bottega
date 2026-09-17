import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  backfillLandingEvidenceRecords,
  CONTENTION_RECORD_PAYLOAD_COLUMNS,
  LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS,
  LANDING_RECORD_PAYLOAD_COLUMNS,
  LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS,
  TEST_FLAKE_RECORD_PAYLOAD_COLUMNS,
} from './landing-outbox.ts'

test('landing evidence backfill mints references in order, maps every column, and is idempotent', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id','machine-record')").run()
  database
    .query(`INSERT INTO run
      (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES (1,'run-record','2026-09-15T00:00:00Z','codex','test','sha',1,'head','ok')`)
    .run()
  database
    .query(
      "INSERT INTO review (id,record_id,recorded_at) VALUES (1,'review-record','2026-09-15T00:01:00Z')",
    )
    .run()
  database
    .query(`INSERT INTO landing
      (id,project,branch,tip,trunk_before,status,error,session_id,started_at,finished_at,
       heartbeat_delivered_at,path_set,requested_at,steps,claim_pid,claim_session)
      VALUES (1,'fixture','DEV-1','tip','trunk','landed',NULL,'session','2026-09-15T00:02:00Z',
       '2026-09-15T00:03:00Z','2026-09-15T00:04:00Z','["a.ts"]','2026-09-15T00:01:00Z',
       '["gate"]',42,'claim')`)
    .run()
  database
    .query(`INSERT INTO landing
      (id,project,branch,status,started_at,causing_landing_id)
      VALUES (2,'fixture','DEV-2','refused','2026-09-15T00:05:00Z',1)`)
    .run()
  database
    .query(`INSERT INTO landing_override
      (id,project,branch,tip,tree,reason,session_id,at)
      VALUES (1,'fixture','DEV-1','tip','tree','reason','session','2026-09-15T00:06:00Z')`)
    .run()
  database
    .query(`INSERT INTO landing_review_carry
      (id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,
       old_base,new_base,session_id,at)
      VALUES (1,'fixture','DEV-1','tip','tree',1,'commit','reviewed-tree','patch',
       'old','new','session','2026-09-15T00:07:00Z')`)
    .run()
  database
    .query(`INSERT INTO contention
      (id,at,session_id,resource_kind,resource_key,event_kind,duration_ms,cause,run_id,landing_id)
      VALUES (1,'2026-09-15T00:08:00Z','session','lock','resource','wait',12,'cause',1,1)`)
    .run()
  database
    .query(`INSERT INTO test_flake
      (id,test,file,load_at_failure,signal,at)
      VALUES (1,'test name','test.ts','{"load":1}','SIGTERM','2026-09-15T00:09:00Z')`)
    .run()

  expect(backfillLandingEvidenceRecords(database)).toEqual({
    mintedLandings: 2,
    mintedOverrides: 1,
    mintedCarries: 1,
    mintedContentions: 1,
    mintedFlakes: 1,
    enqueuedLandings: 2,
    enqueuedOverrides: 1,
    enqueuedCarries: 1,
    enqueuedContentions: 1,
    enqueuedFlakes: 1,
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
  expect(JSON.parse(rows[3]!.payload).reviewId).toBe('review-record')
  expect(JSON.parse(rows[4]!.payload)).toMatchObject({
    runId: 'run-record',
    landingId: firstLanding.id,
  })
  expect(JSON.parse(rows[5]!.payload).projectName).toBeNull()

  expect(backfillLandingEvidenceRecords(database)).toEqual({
    mintedLandings: 0,
    mintedOverrides: 0,
    mintedCarries: 0,
    mintedContentions: 0,
    mintedFlakes: 0,
    enqueuedLandings: 0,
    enqueuedOverrides: 0,
    enqueuedCarries: 0,
    enqueuedContentions: 0,
    enqueuedFlakes: 0,
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(6)
  database.close()
})
