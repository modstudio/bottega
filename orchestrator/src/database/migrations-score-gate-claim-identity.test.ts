import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMigrations,
  canonicalSchemaHash,
  expectedSchemaHash,
  MIGRATIONS_FOLDER,
  migrationJournal,
} from './migrations.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TABLES = [
  'blocker',
  'calibration',
  'canon_eval',
  'compared_pair',
  'duel',
  'run_carried_ruling',
  'run_checkpoint',
  'run_mutation_audit',
  'score',
  'gate_execution',
  'check_execution',
  'resource_claim',
  'question_delivery',
  'question_mutation_audit',
  'review_finding_amendment',
] as const

test('score gate claim and audit identity migration fills ids, keeps rows and keys, and preserves schema', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-score-gate-claim-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex(
    (entry) => entry.tag === '0107_score_gate_claim_audit_record_identity',
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
         VALUES (1,'01990000-0000-7000-8000-000000000701','2026-10-14','codex','implement','sha',1,
           'prompt','ok'),
                (2,'01990000-0000-7000-8000-000000000702','2026-10-14','codex','implement','sha',1,
           'prompt','ok')`,
      )
      .run()
    database
      .query(
        `INSERT INTO question (id,record_id,run_id,asked_at,question)
         VALUES (1,'01990000-0000-7000-8000-000000000711',1,'2026-10-14','One?'),
                (2,'01990000-0000-7000-8000-000000000712',2,'2026-10-14','Two?')`,
      )
      .run()
    database
      .query(
        "INSERT INTO review (id,record_id,recorded_at) VALUES (1,'01990000-0000-7000-8000-000000000721','2026-10-14')",
      )
      .run()

    database
      .query(
        `INSERT INTO blocker (run_id,at,what,why,impact,source,kind)
         VALUES (1,'2026-10-14','missing','why','impact','declared','tool'),
                (2,'2026-10-14','other','why','impact','detected','tool')`,
      )
      .run()
    database
      .query(
        `INSERT INTO calibration (run_id,delivery,quality,fidelity,at,session_id)
         VALUES (1,'full','right','faithful','2026-10-14','s'),
                (2,'none',NULL,NULL,'2026-10-14','s')`,
      )
      .run()
    database
      .query(
        `INSERT INTO canon_eval (slug,run_id,canon_sha,agent,model,pass,why,at)
         VALUES ('one',1,'sha','codex','m',1,'ok','2026-10-14'),
                ('two',2,'sha','codex','m',0,'no','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO compared_pair (run_a_id,run_b_id,compared_at)
         VALUES (1,2,'2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO duel (job,winner_run_id,loser_run_id,session_id,at)
         VALUES ('implement',1,2,'s','2026-10-14')`,
      )
      .run()
    database.query('INSERT INTO run_carried_ruling (run_id,question_id) VALUES (1,1),(2,2)').run()
    database
      .query(
        `INSERT INTO run_checkpoint (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
         VALUES (1,1,'abc','pointer',0,'2026-10-14'),
                (1,2,'def','later',1,'2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO run_mutation_audit (run_id,root_id,action,actor_session,at,reason)
         VALUES (1,1,'score','s','2026-10-14','because'),
                (2,2,'continue','s','2026-10-14','again')`,
      )
      .run()
    database
      .query(
        `INSERT INTO score (run_id,delivery,quality,fidelity,note,scored_at,scored_by)
         VALUES (1,'full','right','faithful','note','2026-10-14','architect'),
                (2,'none',NULL,NULL,NULL,'2026-10-14','architect')`,
      )
      .run()
    database
      .query(
        `INSERT INTO gate_execution
         (id,run_id,requested_at,started_at,finished_at,exit_code)
         VALUES (1,1,'2026-10-14','2026-10-14','2026-10-14',0),
                (2,2,'2026-10-14','2026-10-14','2026-10-14',1)`,
      )
      .run()
    database
      .query(
        `INSERT INTO check_execution
         (gate_execution_id,check_name,category,wall_ms,cpu_ms,exit_code,remaining_count)
         VALUES (1,'typecheck','types',1.5,0.5,0,0),
                (2,'lint','lint',2.0,NULL,1,3)`,
      )
      .run()
    database
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,kind,allocation_key,state,claimed_at)
         VALUES (1,1,'worktree','/tree-a','claimed','2026-10-14'),
                (2,2,'worktree','/tree-b','released','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO question_delivery (question_id,run_id,mode,outcome,at,error)
         VALUES (1,1,'resume','delivered','2026-10-14',NULL),
                (2,2,'live','failed','2026-10-14','boom')`,
      )
      .run()
    database
      .query(
        `INSERT INTO question_mutation_audit (question_id,action,actor_session,at,reason)
         VALUES (1,'rule','s','2026-10-14','one'),
                (2,'close','s','2026-10-14','two')`,
      )
      .run()
    database
      .query(
        `INSERT INTO review_finding_amendment
         (review_id,finding_ordinal,new_disposition,reason,at)
         VALUES (1,1,'accepted','keep','2026-10-14'),
                (1,2,'rejected','drop','2026-10-14')`,
      )
      .run()

    const before = Object.fromEntries(
      TABLES.map((table) => [
        table,
        (database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    )
    expect(applyMigrations(database)).toEqual(['0107_score_gate_claim_audit_record_identity'])
    for (const table of TABLES) {
      expect(database.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
        n: before[table],
      })
      const ids = database.query<{ record_id: string }, []>(`SELECT record_id FROM ${table}`).all()
      expect(ids.length).toBe(before[table]!)
      expect(new Set(ids.map((row) => row.record_id)).size).toBe(ids.length)
      for (const row of ids) expect(row.record_id).toMatch(UUID_V4)
      expect(
        database
          .query<{ unique: number }, []>(
            `SELECT "unique" FROM pragma_index_list('${table}')
             WHERE name='${table}_record_id_unique'`,
          )
          .get()?.unique,
      ).toBe(1)
      expect(
        database
          .query<{ notnull: number }, []>(
            `SELECT "notnull" FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get()?.notnull,
      ).toBe(1)
      expect(
        database
          .query<{ dflt_value: string | null }, []>(
            `SELECT dflt_value FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get()?.dflt_value,
      ).toBeNull()
    }
    expect(database.query('SELECT run_a_id,run_b_id FROM compared_pair').get()).toEqual({
      run_a_id: 1,
      run_b_id: 2,
    })
    expect(
      database.query('SELECT run_id,question_id FROM run_carried_ruling ORDER BY run_id').all(),
    ).toEqual([
      { run_id: 1, question_id: 1 },
      { run_id: 2, question_id: 2 },
    ])
    expect(database.query('SELECT winner_run_id,loser_run_id FROM duel').get()).toEqual({
      winner_run_id: 1,
      loser_run_id: 2,
    })
    expect(
      database.query('SELECT gate_execution_id,check_name FROM check_execution ORDER BY id').all(),
    ).toEqual([
      { gate_execution_id: 1, check_name: 'typecheck' },
      { gate_execution_id: 2, check_name: 'lint' },
    ])
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
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
