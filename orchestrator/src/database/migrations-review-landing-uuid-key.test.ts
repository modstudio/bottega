import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nextReviewNumber } from '../review/review-number.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const TABLES = [
  'review',
  'review_lens',
  'review_finding',
  'review_read',
  'review_finding_amendment',
  'landing',
  'landing_override',
  'landing_review_carry',
  'landing_triage_snapshot',
  'contention',
  'test_flake',
] as const

function count(database: Database, table: string): number {
  return database.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n
}

function leadingIndexColumns(database: Database, table: string): Set<string> {
  const indexes = database
    .query<{ name: string }, []>(`SELECT name FROM pragma_index_list('${table}')`)
    .all()
  return new Set(
    indexes.flatMap(({ name }) =>
      database
        .query<{ name: string }, []>(`SELECT name FROM pragma_index_info('${name}') WHERE seqno=0`)
        .all()
        .map((row) => row.name),
    ),
  )
}

test('review and landing UUID-key migration preserves every table, relationship, cascade, and number', () => {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  try {
    applyMigrationsBefore(database, '0126_review_landing_uuid_key')
    const ids = {
      run: newRecordId(),
      review: newRecordId(),
      lens: newRecordId(),
      finding: newRecordId(),
      read: newRecordId(),
      amendment: newRecordId(),
      landing: newRecordId(),
      cause: newRecordId(),
      override: newRecordId(),
      carry: newRecordId(),
      snapshot: newRecordId(),
      contention: newRecordId(),
      flake: newRecordId(),
    }
    database
      .query(`INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES (?,1,'2026-10-19','codex','review','sha',1,'prompt','ok')`)
      .run(ids.run)
    database
      .query(
        "INSERT INTO review(id,record_id,recorded_at,completed_at,tier) VALUES (41,?,'2026-10-19','2026-10-19',2)",
      )
      .run(ids.review)
    database
      .query(`INSERT INTO review_lens(id,record_id,review_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
      VALUES (42,?,41,?,'correctness','codex','[]','[]','[]','[]')`)
      .run(ids.lens, ids.run)
    database
      .query(`INSERT INTO review_finding(id,record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction,disposition)
      VALUES (43,?,41,42,1,'high','a.ts:1','evidence','fix','accepted')`)
      .run(ids.finding)
    database
      .query(`INSERT INTO review_read(id,record_id,project,branch,tip,patch_id,path_set,tier,note,recorded_at)
      VALUES (44,?,'${PLATFORM_NAME}','DEV-1214','tip','patch','[]',2,'read','2026-10-19')`)
      .run(ids.read)
    database
      .query(`INSERT INTO review_finding_amendment(record_id,review_id,finding_ordinal,new_disposition,reason,at)
      VALUES (?,41,1,'accepted','confirmed','2026-10-19')`)
      .run(ids.amendment)
    database
      .query(
        `INSERT INTO landing(id,record_id,project,branch,status,started_at) VALUES (45,?,'${PLATFORM_NAME}','DEV-1214','landed','2026-10-19')`,
      )
      .run(ids.cause)
    database
      .query(
        `INSERT INTO landing(id,record_id,project,branch,status,started_at,causing_landing_id) VALUES (46,?,'${PLATFORM_NAME}','DEV-1214-next','queued','2026-10-19',45)`,
      )
      .run(ids.landing)
    database
      .query(`INSERT INTO landing_override(id,record_id,project,branch,tip,tree,reason,at)
      VALUES (47,?,'${PLATFORM_NAME}','DEV-1214','tip','tree','reason','2026-10-19')`)
      .run(ids.override)
    database
      .query(`INSERT INTO landing_review_carry(record_id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at)
      VALUES (?,'${PLATFORM_NAME}','DEV-1214','tip','tree',41,'commit','tree','patch','old','new','2026-10-19')`)
      .run(ids.carry)
    database
      .query(`INSERT INTO landing_triage_snapshot(id,record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,override_id,at,read_id)
      VALUES (48,?,'${PLATFORM_NAME}','DEV-1214','tip','tree','[41]','patch',2,1,1,47,'2026-10-19',44)`)
      .run(ids.snapshot)
    database
      .query(`INSERT INTO contention(record_id,at,resource_kind,resource_key,event_kind,landing_id)
      VALUES (?,'2026-10-19','trunk','main','wait',46)`)
      .run(ids.contention)
    database
      .query(`INSERT INTO test_flake(record_id,test,file,load_at_failure,at)
      VALUES (?,'test','a.test.ts','{}','2026-10-19')`)
      .run(ids.flake)
    database.query("UPDATE sqlite_sequence SET seq=80 WHERE name='review'").run()

    const before = new Map(TABLES.map((table) => [table, count(database, table)]))
    expect(applyMigrations(database)).toContain('0126_review_landing_uuid_key')
    for (const [table, rows] of before) expect(count(database, table), table).toBe(rows)
    expect(database.query('SELECT record_id,number FROM review').get()).toEqual({
      record_id: ids.review,
      number: 41,
    })
    expect(
      database.query('SELECT review_record_id,review_lens_record_id FROM review_finding').get(),
    ).toEqual({ review_record_id: ids.review, review_lens_record_id: ids.lens })
    expect(
      database.query('SELECT review_finding_record_id FROM review_finding_amendment').get(),
    ).toEqual({ review_finding_record_id: ids.finding })
    expect(database.query('SELECT review_record_id FROM landing_review_carry').get()).toEqual({
      review_record_id: ids.review,
    })
    expect(
      database
        .query('SELECT causing_landing_record_id FROM landing WHERE record_id=?')
        .get(ids.landing),
    ).toEqual({ causing_landing_record_id: ids.cause })
    expect(
      database
        .query(
          'SELECT review_record_ids,override_record_id,read_record_id FROM landing_triage_snapshot',
        )
        .get(),
    ).toEqual({
      review_record_ids: JSON.stringify([ids.review]),
      override_record_id: ids.override,
      read_record_id: ids.read,
    })
    expect(database.query('SELECT landing_record_id FROM contention').get()).toEqual({
      landing_record_id: ids.landing,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      database.query("SELECT last_number FROM entity_number_counter WHERE entity='review'").get(),
    ).toEqual({ last_number: 80 })
    expect(nextReviewNumber(database)).toBe(81)
    database.query('DELETE FROM review_finding_amendment').run()
    database.query('DELETE FROM landing_review_carry').run()
    database.query('DELETE FROM review WHERE record_id=?').run(ids.review)
    expect(count(database, 'review_lens')).toBe(0)
    expect(count(database, 'review_finding')).toBe(0)
    expect(nextReviewNumber(database)).toBe(82)
  } finally {
    database.close()
  }
})

test('every declared review and landing foreign key leads an index', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    for (const table of TABLES) {
      const indexed = leadingIndexColumns(database, table)
      const foreignKeys = database
        .query<{ from: string }, []>(`SELECT "from" FROM pragma_foreign_key_list('${table}')`)
        .all()
      for (const foreignKey of foreignKeys)
        expect(indexed.has(foreignKey.from), `${table}.${foreignKey.from}`).toBe(true)
    }
  } finally {
    database.close()
  }
})

const ORPHANS = [
  `INSERT INTO review_lens(record_id,review_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify) VALUES ('01990000-0000-7000-8000-000000000001',999,'01990000-0000-7000-8000-000000000002','correctness','codex','[]','[]','[]','[]')`,
  `INSERT INTO review_finding(record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction) VALUES ('01990000-0000-7000-8000-000000000003',999,1,1,'high','a','e','f')`,
  `INSERT INTO review_finding(record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction) VALUES ('01990000-0000-7000-8000-000000000004',1,999,1,'high','a','e','f')`,
  `INSERT INTO review(id,record_id,recorded_at) VALUES (1,'01990000-0000-7000-8000-000000000012','now')`,
  `INSERT INTO review_finding_amendment(record_id,review_id,finding_ordinal,new_disposition,reason,at) VALUES ('01990000-0000-7000-8000-000000000005',1,999,'accepted','r','now')`,
  `INSERT INTO landing_review_carry(record_id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at) VALUES ('01990000-0000-7000-8000-000000000006','p','b','t','tree',999,'c','tree','patch','a','b','now')`,
  `INSERT INTO landing(record_id,project,branch,status,started_at,causing_landing_id) VALUES ('01990000-0000-7000-8000-000000000007','p','b','queued','now',999)`,
  `INSERT INTO landing_triage_snapshot(record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,override_id,at) VALUES ('01990000-0000-7000-8000-000000000008','p','b','t','tree','[]','patch',1,0,0,999,'now')`,
  `INSERT INTO landing_triage_snapshot(record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,read_id,at) VALUES ('01990000-0000-7000-8000-000000000009','p','b2','t','tree','[]','patch',1,0,0,999,'now')`,
  `INSERT INTO contention(record_id,at,resource_kind,resource_key,event_kind,landing_id) VALUES ('01990000-0000-7000-8000-000000000010','now','trunk','main','wait',999)`,
  `INSERT INTO landing_triage_snapshot(record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,at) VALUES ('01990000-0000-7000-8000-000000000011','p','b3','t','tree','[999]','patch',1,0,0,'now')`,
] as const

test('review and landing UUID-key migration reports every orphan without changing the store', () => {
  const database = new Database(':memory:')
  try {
    applyMigrationsBefore(database, '0126_review_landing_uuid_key')
    database.exec('PRAGMA foreign_keys=OFF')
    for (const insert of ORPHANS) database.exec(insert)
    expect(() => applyMigrations(database)).toThrow(
      'review_lens.review_record_id=1, review_finding.review_record_id=1, review_finding.review_lens_record_id=1, landing_review_carry.review_record_id=1, landing.causing_landing_record_id=1, landing_triage_snapshot.override_record_id=1, landing_triage_snapshot.read_record_id=1, contention.landing_record_id=1, review_finding_amendment.review_finding_record_id=1, landing_triage_snapshot.review_record_ids=1',
    )
    expect(
      database.query("SELECT name FROM pragma_table_info('review') ORDER BY cid").all(),
    ).toContainEqual({
      name: 'id',
    })
    expect(count(database, 'review_lens')).toBe(1)
    expect(count(database, 'review_finding_amendment')).toBe(1)
  } finally {
    database.close()
  }
})
