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
  'agent',
  'branch_landing_record',
  'canon_pack',
  'doc_related_subject',
  'metric',
  'monitor_condition',
  'monitor_invocation',
  'operator_notification',
  'probe',
  'run_message',
  'spawn',
  'worker_note_request',
] as const

test('remaining store identity migration fills ids and preserves rows, keys, and schema', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-remaining-store-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex(
    (entry) => entry.tag === '0109_remaining_store_record_identity',
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
    database.exec(`
      INSERT INTO project (id,name,path,canon,settings) VALUES (1,'one','/one',1,'{}');
      INSERT INTO run (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
        VALUES (1,'01990000-0000-7000-8000-000000000901','2026-10-14','codex','implement','sha',1,'p','running');
      INSERT INTO subject (id,project_id,name,definition,position,created_at,updated_at)
        VALUES ('01990000-0000-7000-8000-000000000902',1,'Subject','Definition',0,'2026-10-14','2026-10-14');
      INSERT INTO doc (id,scope,subject,slug,title,project_id,body,created_at,updated_at,record_id,audiences)
        VALUES (1,'project','one','doc','Doc',1,'body','2026-10-14','2026-10-14','01990000-0000-7000-8000-000000000903','["architect"]');
      INSERT INTO agent (name,harness,backend,model,transport,caps,billing,operated_by,enabled)
        VALUES ('worker','codex','vendor','m','acp','{}','subscription','vendor',1);
      INSERT INTO branch_landing_record (project,branch,tip,pr_number,merged_at,recorded_at)
        VALUES ('one','DEV-1','abc',1,'2026-10-14','2026-10-14');
      INSERT INTO canon_pack (id,job,project,sha256,bytes,doc_count,doc_revisions,compiled_at,findings,project_id)
        VALUES (1,'implement','one','sha',1,1,'[]','2026-10-14',0,1);
      INSERT INTO doc_related_subject (id,doc_record_id,subject_id)
        VALUES ('01990000-0000-7000-8000-000000000904','01990000-0000-7000-8000-000000000903','01990000-0000-7000-8000-000000000902');
      INSERT INTO metric (day,claude_tokens,cache_read,messages,tasks,collected_at)
        VALUES ('2026-10-14',1,2,3,4,'2026-10-14');
      INSERT INTO monitor_invocation (id,started_at,trigger) VALUES (1,'2026-10-14','invoked');
      INSERT INTO monitor_condition (id,invocation_id,kind,subject,detail,action)
        VALUES (1,1,'held','tree','detail','act');
      INSERT INTO operator_notification (kind,item_id,episode,notified_at)
        VALUES ('question',1,'one','2026-10-14');
      INSERT INTO probe (id,command,cwd,exit_code,output_tail,created_at)
        VALUES (1,'[]','/tmp',0,'ok','2026-10-14');
      INSERT INTO run_message (id,direction,root_run_id,run_id,body,created_at,delivery)
        VALUES (1,'to_worker',1,1,'hello','2026-10-14','architect_cli');
      INSERT INTO spawn (id,at,decision,why) VALUES (1,'2026-10-14','allowed','test');
      INSERT INTO worker_note_request (id,run_id,text,requested_at,status)
        VALUES (1,1,'note','2026-10-14','requested');
    `)
    const before = Object.fromEntries(
      TABLES.map((table) => [
        table,
        (database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    )
    expect(applyMigrations(database)).toEqual(['0109_remaining_store_record_identity'])
    for (const table of TABLES) {
      expect(database.query(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({
        n: before[table],
      })
      const ids = database.query<{ record_id: string }, []>(`SELECT record_id FROM ${table}`).all()
      expect(ids).toHaveLength(before[table]!)
      expect(new Set(ids.map((row) => row.record_id)).size).toBe(ids.length)
      for (const row of ids) expect(row.record_id).toMatch(UUID_V4)
      expect(
        database
          .query<{ unique: number }, []>(
            `SELECT "unique" FROM pragma_index_list('${table}') WHERE name='${table}_record_id_unique'`,
          )
          .get()?.unique,
      ).toBe(1)
      expect(
        database
          .query<{ notnull: number; dflt_value: string | null }, []>(
            `SELECT "notnull",dflt_value FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get(),
      ).toEqual({ notnull: 1, dflt_value: null })
    }
    expect(database.query("SELECT name FROM agent WHERE name='worker'").get()).toEqual({
      name: 'worker',
    })
    expect(database.query('SELECT project,branch FROM branch_landing_record').get()).toEqual({
      project: 'one',
      branch: 'DEV-1',
    })
    expect(database.query('SELECT invocation_id FROM monitor_condition').get()).toEqual({
      invocation_id: 1,
    })
    expect(database.query("SELECT collected_at,canon_tokens FROM metric WHERE day='2026-10-14'").get()).toEqual({
      collected_at: '2026-10-14',
      canon_tokens: 0,
    })
    expect(database.query('SELECT delivery,read_by FROM run_message').get()).toEqual({
      delivery: 'architect_cli',
      read_by: null,
    })
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
