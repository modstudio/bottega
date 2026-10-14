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
  'workflow',
  'workflow_version',
  'workflow_event',
  'workflow_cursor',
  'workflow_obligation',
  'workflow_step_text',
  'step_catalogue',
  'step_catalogue_version',
  'step_catalogue_event',
  'lens',
  'lens_revision',
  'lens_profile',
  'lens_profile_revision',
  'project_lens_profile',
  'project_lens_profile_revision',
  'port_pair',
  'port_baseline',
  'port_doctrine',
  'port_ref',
  'port_ref_source',
  'port_skip',
] as const

test('workflow lens and port identity migration fills ids, keeps rows and keys, and preserves schema', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-workflow-lens-port-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex(
    (entry) => entry.tag === '0108_workflow_lens_port_record_identity',
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
    const project = database
      .query(
        `INSERT INTO project (name,path,canon,settings) VALUES ('one','/one',1,'{}') RETURNING id`,
      )
      .get() as { id: number }
    const other = database
      .query(
        `INSERT INTO project (name,path,canon,settings) VALUES ('two','/two',1,'{}') RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO workflow (id,slug,created_at) VALUES (1,'alpha','2026-10-14'),(2,'beta','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_version
         (workflow_id,n,status,definition,author,reason,created_at,promoted_at)
         VALUES (1,1,'production','{}','seed','reason','2026-10-14','2026-10-14'),
                (2,1,'draft','{}','seed','reason','2026-10-14',NULL)`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_event
         (workflow_id,version_n,event,author,reason,session_id,at)
         VALUES (1,1,'set','seed','reason',NULL,'2026-10-14'),
                (2,1,'set','seed','reason',NULL,'2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_cursor
         (id,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
          workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
          total_steps,created_at,updated_at,enforcement)
         VALUES (1,'one','alpha','default','DEV-1','','s',1,1,'{}',0,'build','running','[]',NULL,
                 1,'2026-10-14','2026-10-14','floors'),
                (2,'two','beta','default','DEV-2','','s',1,1,'{}',0,'build','running','[]',NULL,
                 1,'2026-10-14','2026-10-14','note-only')`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_obligation
         (cursor_id,step_ordinal,step_slug,floor,reason,created_at)
         VALUES (1,1,'build','command-exit','later','2026-10-14'),
                (2,1,'build','command-exit','later','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_step_text
         (cursor_id,step_ordinal,step_slug,body,created_at)
         VALUES (1,1,'build','body-a','2026-10-14'),
                (2,1,'build','body-b','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO step_catalogue (id,slug,created_at) VALUES (1,'shared','2026-10-14'),(2,'other','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO step_catalogue_version
         (catalogue_id,n,status,definition,author,reason,created_at,promoted_at)
         VALUES (1,1,'production','{"steps":[]}','seed','reason','2026-10-14','2026-10-14'),
                (2,1,'draft','{"steps":[]}','seed','reason','2026-10-14',NULL)`,
      )
      .run()
    database
      .query(
        `INSERT INTO step_catalogue_event
         (catalogue_id,version_n,event,author,reason,session_id,at)
         VALUES (1,1,'set','seed','reason',NULL,'2026-10-14'),
                (2,1,'set','seed','reason',NULL,'2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO lens (id,title,question,excludes,slots,version,enabled,requires_execution)
         VALUES ('one','One','Q?','no','{}',1,1,0),
                ('two','Two','Q?','no','{}',1,1,0)`,
      )
      .run()
    database
      .query(
        `INSERT INTO lens_revision (lens_id,version,prior_body,reason,at)
         VALUES ('one',1,'{}','edit','2026-10-14'),
                ('two',1,'{}','edit','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO lens_profile (lens_id,axis,name,version,body,enabled)
         VALUES ('one','framework','default',1,'{}',1),
                ('two','framework','default',1,'{}',1)`,
      )
      .run()
    database
      .query(
        `INSERT INTO lens_profile_revision (profile_id,version,prior_body,reason,at)
         VALUES (1,1,'{}','edit','2026-10-14'),
                (2,1,'{}','edit','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO project_lens_profile (project_id,lens_id,axis,profile_name)
         VALUES (?, 'one','framework','default'),
                (?, 'two','framework','default')`,
      )
      .run(project.id, other.id)
    database
      .query(
        `INSERT INTO project_lens_profile_revision (selection_id,reason,at)
         VALUES (1,'pick','2026-10-14'),
                (2,'pick','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO port_pair (id,source_project_id,target_project_id,created_at)
         VALUES (1,?,?, '2026-10-14'),
                (2,?,?, '2026-10-14')`,
      )
      .run(project.id, other.id, other.id, project.id)
    database
      .query(
        `INSERT INTO port_baseline (pair_id,source_commit,scanned_at)
         VALUES (1,'abc','2026-10-14'),
                (2,NULL,NULL)`,
      )
      .run()
    database
      .query(
        `INSERT INTO port_doctrine (number,title,body,created_at)
         VALUES (1,'First','Body','2026-10-14'),
                (2,'Second','Body','2026-10-14')`,
      )
      .run()
    database
      .query(
        `INSERT INTO port_ref (task_key,target_project_id,note,created_at)
         VALUES ('TGT-1',?,'note','2026-10-14'),
                ('TGT-2',?,'note','2026-10-14')`,
      )
      .run(project.id, other.id)
    database
      .query(
        `INSERT INTO port_ref_source (task_key,target_project_id,source_project_id,commits,paths,note)
         VALUES ('TGT-1',?,?, '[]','[]','src'),
                ('TGT-2',?,?, '[]','[]','src')`,
      )
      .run(project.id, other.id, other.id, project.id)
    database
      .query(
        `INSERT INTO port_skip (pair_id,candidate,reason,skipped_at)
         VALUES (1,'cand-a','no','2026-10-14'),
                (2,'cand-b','no','2026-10-14')`,
      )
      .run()

    const before = Object.fromEntries(
      TABLES.map((table) => [
        table,
        (database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    )
    expect(applyMigrations(database)).toEqual([
      '0108_workflow_lens_port_record_identity',
      '0109_remaining_store_record_identity',
    ])
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
    expect(
      database
        .query("SELECT slug FROM workflow WHERE slug IN ('alpha','beta') ORDER BY slug")
        .all(),
    ).toEqual([{ slug: 'alpha' }, { slug: 'beta' }])
    expect(
      database.query("SELECT id FROM lens WHERE id IN ('one','two') ORDER BY id").all(),
    ).toEqual([{ id: 'one' }, { id: 'two' }])
    expect(database.query('SELECT number FROM port_doctrine ORDER BY number').all()).toEqual([
      { number: 1 },
      { number: 2 },
    ])
    expect(
      database
        .query(
          "SELECT target_project_id,task_key FROM port_ref WHERE task_key IN ('TGT-1','TGT-2') ORDER BY task_key",
        )
        .all(),
    ).toEqual([
      { target_project_id: project.id, task_key: 'TGT-1' },
      { target_project_id: other.id, task_key: 'TGT-2' },
    ])
    expect(
      database
        .query(
          'SELECT workflow_id,n FROM workflow_version WHERE workflow_id IN (1,2) ORDER BY workflow_id',
        )
        .all(),
    ).toEqual([
      { workflow_id: 1, n: 1 },
      { workflow_id: 2, n: 1 },
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
