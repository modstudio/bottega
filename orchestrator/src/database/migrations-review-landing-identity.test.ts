import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMigrations,
  applyMigrationsBefore,
  canonicalSchemaHash,
  expectedSchemaHash,
  MIGRATIONS_FOLDER,
  migrationJournal,
} from './migrations.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TABLES = [
  'review',
  'review_lens',
  'review_finding',
  'landing',
  'landing_override',
  'landing_review_carry',
  'contention',
  'test_flake',
  'release_ledger',
  'doc_revision',
] as const

test('review landing release and doc identity migration fills nulls, keeps identities, and preserves schema', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-review-landing-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex(
    (entry) => entry.tag === '0106_review_landing_release_doc_record_identity',
  )
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON')
    applyMigrations(database, folder)
    database
      .query(
        `INSERT INTO run
         (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (1,'01990000-0000-7000-8000-000000000501','2026-10-14','codex','review-lens','sha',1,
           'prompt','ok'),
                (2,'01990000-0000-7000-8000-000000000502','2026-10-14','codex','review-lens','sha',1,
           'prompt','ok')`,
      )
      .run()
    const kept = {
      review: '01990000-0000-7000-8000-000000000601',
      lens: '01990000-0000-7000-8000-000000000602',
      finding: '01990000-0000-7000-8000-000000000603',
      landing: '01990000-0000-7000-8000-000000000604',
      override: '01990000-0000-7000-8000-000000000605',
      carry: '01990000-0000-7000-8000-000000000606',
      contention: '01990000-0000-7000-8000-000000000607',
      flake: '01990000-0000-7000-8000-000000000608',
      release: '01990000-0000-7000-8000-000000000609',
      revision: '01990000-0000-7000-8000-000000000610',
    }
    database.query("INSERT INTO review (id,recorded_at) VALUES (1,'2026-10-14')").run()
    database
      .query("INSERT INTO review (id,record_id,recorded_at) VALUES (2,?,'2026-10-14')")
      .run(kept.review)
    database
      .query(
        `INSERT INTO review_lens
         (id,review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (1,1,1,'craft','codex','[]','[]','[]','[]')`,
      )
      .run()
    database
      .query(
        `INSERT INTO review_lens
         (id,record_id,review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (2,?,2,2,'safety','codex','[]','[]','[]','[]')`,
      )
      .run(kept.lens)
    database
      .query(
        `INSERT INTO review_finding
         (id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction)
         VALUES (1,1,1,1,'major','a.ts:1','evidence','correct it')`,
      )
      .run()
    database
      .query(
        `INSERT INTO review_finding
         (id,record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction)
         VALUES (2,?,2,2,1,'high','b.ts:1','kept','correct it')`,
      )
      .run(kept.finding)
    database
      .query(
        `INSERT INTO review_finding_amendment
         (review_id,finding_ordinal,new_disposition,reason,at)
         VALUES (1,1,'accepted','keep dependent','2026-10-14')`,
      )
      .run()
    database
      .query(
        "INSERT INTO landing (id,project,branch,status,started_at) VALUES (1,'p','b','queued','2026-10-14')",
      )
      .run()
    database
      .query(
        "INSERT INTO landing (id,record_id,project,branch,status,started_at) VALUES (2,?,'p','c','queued','2026-10-14')",
      )
      .run(kept.landing)
    database
      .query(
        `INSERT INTO landing_override
         (id,project,branch,tip,tree,reason,at) VALUES (1,'p','b','tip','tree','reason','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO landing_override
         (id,record_id,project,branch,tip,tree,reason,at)
         VALUES (2,?,'p','c','tip','tree','reason','2026-10-14')`,
      )
      .run(kept.override)
    database
      .query(
        `INSERT INTO landing_triage_snapshot
         (record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,override_id,at)
         VALUES ('01990000-0000-7000-8000-000000000611','p','b','tip','tree','[]','patch',1,0,0,1,'2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO landing_review_carry
         (id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at)
         VALUES (1,'p','b','tip','tree',1,'old','tree','patch','a','b','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO landing_review_carry
         (id,record_id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at)
         VALUES (2,?,'p','c','tip','tree',2,'old','tree','patch','a','b','2026-10-14')`,
      )
      .run(kept.carry)
    database
      .query(
        `INSERT INTO contention (id,at,resource_kind,resource_key,event_kind,landing_id)
         VALUES (1,'2026-10-14','lock','k','wait',1)`,
      )
      .run()
    database
      .query(
        `INSERT INTO contention (id,record_id,at,resource_kind,resource_key,event_kind,landing_id)
         VALUES (2,?,'2026-10-14','lock','k','wait',2)`,
      )
      .run(kept.contention)
    database
      .query(
        `INSERT INTO test_flake (id,test,file,load_at_failure,at)
         VALUES (1,'t','f.ts','{}','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO test_flake (id,record_id,test,file,load_at_failure,at)
         VALUES (2,?,'t','g.ts','{}','2026-10-14')`,
      )
      .run(kept.flake)
    database
      .query(
        `INSERT INTO release_ledger
         (id,project,rung,candidate_commit,rollback,actor,started_at)
         VALUES (1,'p','production','sha',0,'operator','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO release_ledger
         (id,record_id,project,rung,candidate_commit,rollback,actor,started_at)
         VALUES (2,?,'p','production','sha',0,'operator','2026-10-14')`,
      )
      .run(kept.release)
    database
      .query(
        `INSERT INTO doc_revision
         (id,doc_id,scope,slug,op,title,body,delivery,audiences,author,reason,at)
         VALUES (1,1,'global','missing','set','Title','Body','inject','["technical"]','author','reason','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO doc_revision
         (id,doc_id,scope,slug,op,title,body,delivery,audiences,author,reason,at,record_id)
         VALUES (2,1,'global','kept','set','Title','Body','inject','["technical"]','author','reason','2026-10-14',?)`,
      )
      .run(kept.revision)

    expect(applyMigrationsBefore(database, '0126_review_landing_uuid_key')).toContain(
      '0106_review_landing_release_doc_record_identity',
    )
    const ids = (table: string) =>
      database
        .query<{ id: number; record_id: string }, []>(
          `SELECT id,record_id FROM ${table} ORDER BY id`,
        )
        .all()
    const reviewIds = ids('review')
    expect(reviewIds.find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(reviewIds.find((row) => row.id === 2)?.record_id).toBe(kept.review)
    expect(ids('review_lens').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('review_lens').find((row) => row.id === 2)?.record_id).toBe(kept.lens)
    expect(ids('review_finding').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('review_finding').find((row) => row.id === 2)?.record_id).toBe(kept.finding)
    expect(ids('landing').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('landing').find((row) => row.id === 2)?.record_id).toBe(kept.landing)
    expect(ids('landing_override').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('landing_override').find((row) => row.id === 2)?.record_id).toBe(kept.override)
    expect(ids('landing_review_carry').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('landing_review_carry').find((row) => row.id === 2)?.record_id).toBe(kept.carry)
    expect(ids('contention').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('contention').find((row) => row.id === 2)?.record_id).toBe(kept.contention)
    expect(ids('test_flake').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('test_flake').find((row) => row.id === 2)?.record_id).toBe(kept.flake)
    expect(ids('release_ledger').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('release_ledger').find((row) => row.id === 2)?.record_id).toBe(kept.release)
    expect(ids('doc_revision').find((row) => row.id === 1)?.record_id).toMatch(UUID_V4)
    expect(ids('doc_revision').find((row) => row.id === 2)?.record_id).toBe(kept.revision)
    for (const table of TABLES) {
      expect(database.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 2 })
      expect(
        database
          .query<{ notnull: number }, []>(
            `SELECT "notnull" FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get()?.notnull,
      ).toBe(1)
    }
    expect(
      database.query('SELECT review_id,finding_ordinal FROM review_finding_amendment').get(),
    ).toEqual({
      review_id: 1,
      finding_ordinal: 1,
    })
    expect(database.query('SELECT override_id FROM landing_triage_snapshot').get()).toEqual({
      override_id: 1,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    applyMigrations(database)
    const fresh = new Database(':memory:')
    fresh.exec('PRAGMA foreign_keys=ON')
    applyMigrations(fresh)
    const schemaRows = (subject: Database) =>
      subject
        .query(
          `SELECT type,name,tbl_name,sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
        )
        .all()
    expect(schemaRows(database)).toEqual(schemaRows(fresh))
    expect(canonicalSchemaHash(database)).toBe(canonicalSchemaHash(fresh))
    fresh.close()
    expect(canonicalSchemaHash(database)).toBe(expectedSchemaHash())
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
