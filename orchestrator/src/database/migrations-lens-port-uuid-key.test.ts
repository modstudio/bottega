import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const TABLES = [
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

function before(): Database {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, '0131_lens_port_uuid_key')
  return database
}

function seedPortPair(database: Database, recordId: string, spaceId: string | null): number {
  database
    .query(
      `INSERT INTO port_pair(record_id,space_id,source_project_record_id,target_project_record_id,created_at)
       VALUES (?,?,? ,?,'2026-01-01T00:00:00.000Z')`,
    )
    .run(recordId, spaceId, newRecordId(), newRecordId())
  return Number(database.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id)
}

test('lens and port UUID-key migration rebuilds every catalogue table and relationship', () => {
  const database = before()
  try {
    const lensId = newRecordId()
    const profileId = newRecordId()
    const selectionId = newRecordId()
    database.exec(`
      INSERT INTO lens(record_id,id,title,question,excludes,slots,version,enabled,requires_execution,space_id)
      VALUES ('${lensId}','fixture','Fixture','Q','E','{"type":"object","properties":{},"additionalProperties":false}',1,1,0,NULL);
      INSERT INTO lens_revision(record_id,lens_id,version,prior_body,reason,at,space_id)
      VALUES ('${newRecordId()}','fixture',1,'{}','fixture','a',NULL);
      INSERT INTO lens_profile(record_id,lens_id,axis,name,version,body,enabled,space_id)
      VALUES ('${profileId}','fixture','framework','default',1,'{}',1,NULL);
      INSERT INTO lens_profile_revision(record_id,profile_id,version,prior_body,reason,at,space_id)
      VALUES ('${newRecordId()}',(SELECT id FROM lens_profile WHERE record_id='${profileId}'),1,'{}','fixture','a',NULL);
      INSERT INTO project_lens_profile(record_id,project_record_id,lens_id,axis,profile_name,selection_version,space_id)
      VALUES ('${selectionId}','${newRecordId()}','fixture','framework','default',1,NULL);
      INSERT INTO project_lens_profile_revision(record_id,selection_id,reason,at,space_id)
      VALUES ('${newRecordId()}',(SELECT id FROM project_lens_profile WHERE record_id='${selectionId}'),'fixture','a',NULL);
    `)
    const pairId = seedPortPair(database, newRecordId(), null)
    const refId = newRecordId()
    database.exec(`
      INSERT INTO port_baseline(record_id,pair_id,source_commit,scanned_at,version,space_id) VALUES ('${newRecordId()}',${pairId},NULL,NULL,1,NULL);
      INSERT INTO port_doctrine(record_id,number,title,body,created_at,version,space_id) VALUES ('${newRecordId()}',1,'Rule','Body','a',1,NULL);
      INSERT INTO port_ref(record_id,task_key,target_project_record_id,note,created_at,version,space_id) VALUES ('${refId}','DEV-1','${newRecordId()}','Note','a',1,NULL);
      INSERT INTO port_ref_source(record_id,task_key,target_project_record_id,source_project_record_id,commits,paths,note,space_id)
      SELECT '${newRecordId()}',task_key,target_project_record_id,'${newRecordId()}','[]','[]','Source',NULL FROM port_ref WHERE record_id='${refId}';
      INSERT INTO port_skip(record_id,pair_id,candidate,reason,skipped_at,space_id) VALUES ('${newRecordId()}',${pairId},'candidate','reason','a',NULL);
    `)

    expect(applyMigrations(database)).toContain('0131_lens_port_uuid_key')
    for (const table of TABLES) {
      const primary = database
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') WHERE pk=1`)
        .all()
      expect(primary, table).toHaveLength(1)
      expect(primary[0]!.name, table).toMatch(/record_id$/)
    }
    expect(
      database.query('SELECT lens_record_id FROM lens_profile WHERE record_id=?').get(profileId),
    ).toEqual({
      lens_record_id: lensId,
    })
    expect(
      database
        .query('SELECT profile_record_id FROM lens_profile_revision WHERE profile_record_id=?')
        .get(profileId),
    ).toEqual({ profile_record_id: profileId })
    expect(
      database
        .query(
          'SELECT selection_record_id FROM project_lens_profile_revision WHERE selection_record_id=?',
        )
        .get(selectionId),
    ).toEqual({
      selection_record_id: selectionId,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})

test('bound migration removes matching stale copies, refuses a missing twin atomically, and unbound keeps local rows', () => {
  const matching = before()
  const shared = newRecordId()
  seedPortPair(matching, shared, null)
  matching
    .query(
      `INSERT INTO port_pair(record_id,space_id,source_project_record_id,target_project_record_id,created_at)
       SELECT record_id,?,source_project_record_id,target_project_record_id,created_at
       FROM port_pair WHERE record_id=? AND space_id IS NULL`,
    )
    .run(newRecordId(), shared)
  matching.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
  applyMigrations(matching)
  expect(matching.query('SELECT COUNT(*) n FROM port_pair WHERE space_id IS NULL').get()).toEqual({
    n: 0,
  })
  matching.close()

  const refused = before()
  seedPortPair(refused, newRecordId(), null)
  refused.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'a')")
  expect(() => applyMigrations(refused)).toThrow('without equivalent hosted twins')
  expect(refused.query("SELECT name FROM pragma_table_info('port_pair')").all()).toContainEqual({
    name: 'id',
  })
  refused.close()

  const unbound = before()
  seedPortPair(unbound, newRecordId(), null)
  applyMigrations(unbound)
  expect(unbound.query('SELECT COUNT(*) n FROM port_pair WHERE space_id IS NULL').get()).toEqual({
    n: 1,
  })
  unbound.close()
})

test('lens and port UUID-key migration reports every orphan and leaves the old schema unchanged', () => {
  const database = before()
  try {
    database.exec('PRAGMA foreign_keys=OFF')
    database.exec(`
      INSERT INTO lens_revision(record_id,lens_id,version,prior_body,reason,at) VALUES ('${newRecordId()}','missing',1,'{}','r','a');
      INSERT INTO lens_profile(record_id,lens_id,axis,name,version,body,enabled) VALUES ('${newRecordId()}','missing','framework','x',1,'{}',1);
      INSERT INTO lens_profile_revision(record_id,profile_id,version,prior_body,reason,at) VALUES ('${newRecordId()}',999,1,'{}','r','a');
      INSERT INTO project_lens_profile(record_id,project_record_id,lens_id,axis,profile_name,selection_version) VALUES ('${newRecordId()}','${newRecordId()}','missing','framework','x',1);
      INSERT INTO project_lens_profile_revision(record_id,selection_id,reason,at) VALUES ('${newRecordId()}',999,'r','a');
      INSERT INTO port_baseline(record_id,pair_id,version) VALUES ('${newRecordId()}',999,1);
      INSERT INTO port_skip(record_id,pair_id,candidate,reason,skipped_at) VALUES ('${newRecordId()}',999,'x','r','a');
      INSERT INTO port_ref_source(record_id,task_key,target_project_record_id,source_project_record_id,commits,paths,note) VALUES ('${newRecordId()}','DEV-1','${newRecordId()}','${newRecordId()}','[]','[]','n');
    `)
    expect(() => applyMigrations(database)).toThrow(
      'lens_revision.lens_record_id=1, lens_profile.lens_record_id=1, lens_profile_revision.profile_record_id=1, project_lens_profile.lens_record_id=1, project_lens_profile_revision.selection_record_id=1, port_baseline.pair_record_id=1, port_skip.pair_record_id=1, port_ref_source.ref_record_id=1',
    )
    expect(database.query("SELECT name FROM pragma_table_info('port_pair')").all()).toContainEqual({
      name: 'id',
    })
  } finally {
    database.close()
  }
})

test('every declared lens and port foreign key leads an index', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    for (const table of TABLES) {
      const foreignKeys = database.query<{ from: string }, []>(`PRAGMA foreign_key_list('${table}')`).all()
      const indexed = new Set(
        database
          .query<{ name: string }, []>(`PRAGMA index_list('${table}')`)
          .all()
          .flatMap((index) =>
            database
              .query<{ name: string }, []>(`PRAGMA index_info('${index.name}')`)
              .all()
              .slice(0, 1)
              .map((column) => column.name),
          ),
      )
      const primary = database
        .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
        .all()
        .slice(0, 1)
        .map((column) => column.name)
      for (const column of primary) indexed.add(column)
      for (const foreignKey of foreignKeys)
        expect(indexed.has(foreignKey.from), `${table}.${foreignKey.from}`).toBe(true)
    }
  } finally {
    database.close()
  }
})
