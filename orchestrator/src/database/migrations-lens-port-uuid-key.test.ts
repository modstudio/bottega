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

let beforeTemplate: Uint8Array | undefined

function before(): Database {
  if (!beforeTemplate) {
    const database = new Database(':memory:')
    applyMigrationsBefore(database, '0131_lens_port_uuid_key')
    beforeTemplate = database.serialize()
    database.close()
  }
  const database = Database.deserialize(beforeTemplate)
  database.exec('PRAGMA foreign_keys=ON')
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

type PortTwinIds = {
  hostedPairId: number
  hostedSpaceId: string
}

function seedPortTwins(database: Database): PortTwinIds {
  const hostedSpaceId = newRecordId()
  const pairRecordId = newRecordId()
  database
    .query(
      `INSERT INTO port_pair(record_id,space_id,source_project_record_id,target_project_record_id,created_at)
       VALUES (?,NULL,'source-project','target-project','2026-01-01T00:00:00.000Z')`,
    )
    .run(pairRecordId)
  const localPairId = Number(
    database.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id,
  )
  database
    .query(
      `INSERT INTO port_pair(record_id,space_id,source_project_record_id,target_project_record_id,created_at)
       VALUES (?,?,'source-project','target-project','2026-01-01T00:00:00.000Z')`,
    )
    .run(pairRecordId, hostedSpaceId)
  const hostedPairId = Number(
    database.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id,
  )
  const baselineRecordId = newRecordId()
  const doctrineRecordId = newRecordId()
  const refRecordId = newRecordId()
  const sourceRecordId = newRecordId()
  const skipRecordId = newRecordId()
  database.exec(`
    INSERT INTO port_baseline(pair_id,source_commit,scanned_at,record_id,version,space_id)
      VALUES (${localPairId},'abc123','2026-01-02','${baselineRecordId}',2,NULL);
    INSERT INTO port_baseline(pair_id,source_commit,scanned_at,record_id,version,space_id)
      VALUES (${hostedPairId},'abc123','2026-01-02T00:00:00.000Z','${baselineRecordId}',2,'${hostedSpaceId}');
    INSERT INTO port_doctrine(number,title,body,created_at,retired_at,record_id,version,space_id)
      VALUES (1,'Doctrine','Body','2026-01-01T00:00:00.000Z',NULL,'${doctrineRecordId}',2,NULL);
    INSERT INTO port_doctrine(number,title,body,created_at,retired_at,record_id,version,space_id)
      VALUES (1,'Doctrine','Body','2026-01-01T00:00:00.000Z',NULL,'${doctrineRecordId}',2,'${hostedSpaceId}');
    INSERT INTO port_ref(task_key,target_project_record_id,note,created_at,resolved_at,record_id,version,space_id)
      VALUES ('DEV-1','target-project','Note','2026-01-01T00:00:00.000Z',NULL,'${refRecordId}',2,NULL);
    INSERT INTO port_ref(task_key,target_project_record_id,note,created_at,resolved_at,record_id,version,space_id)
      VALUES ('DEV-1','target-project','Note','2026-01-01T00:00:00.000Z',NULL,'${refRecordId}',2,'${hostedSpaceId}');
    INSERT INTO port_ref_source(task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,space_id)
      VALUES ('DEV-1','target-project','source-project','["abc123"]','["src/a.ts"]','Source','${sourceRecordId}',NULL);
    INSERT INTO port_ref_source(task_key,target_project_record_id,source_project_record_id,commits,paths,note,record_id,space_id)
      VALUES ('DEV-1','target-project','source-project','["abc123"]','["src/a.ts"]','Source','${sourceRecordId}','${hostedSpaceId}');
    INSERT INTO port_skip(pair_id,candidate,reason,skipped_at,record_id,space_id)
      VALUES (${localPairId},'def456','already ported','2026-01-03T00:00:00.000Z','${skipRecordId}',NULL);
    INSERT INTO port_skip(pair_id,candidate,reason,skipped_at,record_id,space_id)
      VALUES (${hostedPairId},'def456','already ported','2026-01-03T00:00:00.000Z','${skipRecordId}','${hostedSpaceId}');
    INSERT INTO record_install_binding(id,bound_at) VALUES (1,'2026-01-04T00:00:00.000Z');
  `)
  return { hostedPairId, hostedSpaceId }
}

function portRows(database: Database): Record<string, unknown[]> {
  return Object.fromEntries(
    TABLES.filter((table) => table.startsWith('port_')).map((table) => [
      table,
      database.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  )
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

test('bound migration removes an all-equal twin from every port table and unbound keeps local rows', () => {
  const matching = before()
  seedPortTwins(matching)
  applyMigrations(matching)
  for (const table of TABLES.filter((candidate) => candidate.startsWith('port_'))) {
    expect(
      matching.query(`SELECT COUNT(*) n FROM ${table} WHERE space_id IS NULL`).get(),
      table,
    ).toEqual({ n: 0 })
    expect(
      matching.query(`SELECT COUNT(*) n FROM ${table} WHERE space_id IS NOT NULL`).get(),
      table,
    ).toEqual({ n: 1 })
  }
  matching.close()

  const unbound = before()
  seedPortPair(unbound, newRecordId(), null)
  applyMigrations(unbound)
  expect(unbound.query('SELECT COUNT(*) n FROM port_pair WHERE space_id IS NULL').get()).toEqual({
    n: 1,
  })
  unbound.close()
})

test('bound migration refuses every port twin content or parent mismatch atomically', () => {
  const variations: Array<{
    label: string
    mutate: (database: Database, ids: PortTwinIds) => void
  }> = [
    {
      label: 'port_pair.source_project_record_id',
      mutate: (d) =>
        d.exec(
          "UPDATE port_pair SET source_project_record_id='other-source' WHERE space_id IS NOT NULL",
        ),
    },
    {
      label: 'port_pair.target_project_record_id',
      mutate: (d) =>
        d.exec(
          "UPDATE port_pair SET target_project_record_id='other-target' WHERE space_id IS NOT NULL",
        ),
    },
    {
      label: 'port_pair.created_at',
      mutate: (d) => d.exec("UPDATE port_pair SET created_at='later' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_baseline.parent pair',
      mutate: (d, ids) => {
        d.query(
          `INSERT INTO port_pair(record_id,space_id,source_project_record_id,target_project_record_id,created_at)
           VALUES (?,?, 'other-source','other-target','2026-01-01T00:00:00.000Z')`,
        ).run(newRecordId(), ids.hostedSpaceId)
        const other = Number(d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id)
        d.query('UPDATE port_baseline SET pair_id=? WHERE space_id IS NOT NULL').run(other)
      },
    },
    {
      label: 'port_baseline.source_commit',
      mutate: (d) =>
        d.exec("UPDATE port_baseline SET source_commit='other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_baseline.scanned_at',
      mutate: (d) =>
        d.exec(
          "UPDATE port_baseline SET scanned_at='2026-01-03T00:00:00.000Z' WHERE space_id IS NOT NULL",
        ),
    },
    {
      label: 'port_baseline.version',
      mutate: (d) => d.exec('UPDATE port_baseline SET version=3 WHERE space_id IS NOT NULL'),
    },
    {
      label: 'port_doctrine.number',
      mutate: (d) => d.exec('UPDATE port_doctrine SET number=2 WHERE space_id IS NOT NULL'),
    },
    {
      label: 'port_doctrine.title',
      mutate: (d) => d.exec("UPDATE port_doctrine SET title='Other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_doctrine.body',
      mutate: (d) => d.exec("UPDATE port_doctrine SET body='Other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_doctrine.created_at',
      mutate: (d) =>
        d.exec("UPDATE port_doctrine SET created_at='later' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_doctrine.retired_at',
      mutate: (d) =>
        d.exec("UPDATE port_doctrine SET retired_at='later' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_doctrine.version',
      mutate: (d) => d.exec('UPDATE port_doctrine SET version=3 WHERE space_id IS NOT NULL'),
    },
    {
      label: 'port_ref.task_key',
      mutate: (d) => {
        d.exec('PRAGMA foreign_keys=OFF')
        d.exec("UPDATE port_ref_source SET task_key='DEV-2' WHERE space_id IS NOT NULL")
        d.exec("UPDATE port_ref SET task_key='DEV-2' WHERE space_id IS NOT NULL")
        d.exec('PRAGMA foreign_keys=ON')
      },
    },
    {
      label: 'port_ref.target_project_record_id',
      mutate: (d) => {
        d.exec('PRAGMA foreign_keys=OFF')
        d.exec(
          "UPDATE port_ref_source SET target_project_record_id='other-target' WHERE space_id IS NOT NULL",
        )
        d.exec(
          "UPDATE port_ref SET target_project_record_id='other-target' WHERE space_id IS NOT NULL",
        )
        d.exec('PRAGMA foreign_keys=ON')
      },
    },
    {
      label: 'port_ref.note',
      mutate: (d) => d.exec("UPDATE port_ref SET note='Other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_ref.created_at',
      mutate: (d) => d.exec("UPDATE port_ref SET created_at='later' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_ref.resolved_at',
      mutate: (d) => d.exec("UPDATE port_ref SET resolved_at='later' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_ref.version',
      mutate: (d) => d.exec('UPDATE port_ref SET version=3 WHERE space_id IS NOT NULL'),
    },
    {
      label: 'port_ref_source parent task_key',
      mutate: (d, ids) => {
        d.query(
          `INSERT INTO port_ref(task_key,target_project_record_id,note,created_at,record_id,version,space_id)
           VALUES ('DEV-2','target-project','Aux','later',?,1,?)`,
        ).run(newRecordId(), ids.hostedSpaceId)
        d.exec("UPDATE port_ref_source SET task_key='DEV-2' WHERE space_id IS NOT NULL")
      },
    },
    {
      label: 'port_ref_source parent target_project_record_id',
      mutate: (d, ids) => {
        d.query(
          `INSERT INTO port_ref(task_key,target_project_record_id,note,created_at,record_id,version,space_id)
           VALUES ('DEV-1','other-target','Aux','later',?,1,?)`,
        ).run(newRecordId(), ids.hostedSpaceId)
        d.exec(
          "UPDATE port_ref_source SET target_project_record_id='other-target' WHERE space_id IS NOT NULL",
        )
      },
    },
    {
      label: 'port_ref_source.source_project_record_id',
      mutate: (d) =>
        d.exec(
          "UPDATE port_ref_source SET source_project_record_id='other-source' WHERE space_id IS NOT NULL",
        ),
    },
    {
      label: 'port_ref_source.commits',
      mutate: (d) => d.exec("UPDATE port_ref_source SET commits='[]' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_ref_source.paths',
      mutate: (d) => d.exec("UPDATE port_ref_source SET paths='[]' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_ref_source.note',
      mutate: (d) => d.exec("UPDATE port_ref_source SET note='Other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_skip.parent pair',
      mutate: (d, ids) => {
        d.query(
          `INSERT INTO port_pair(record_id,space_id,source_project_record_id,target_project_record_id,created_at)
           VALUES (?,?, 'other-source','other-target','2026-01-01T00:00:00.000Z')`,
        ).run(newRecordId(), ids.hostedSpaceId)
        const other = Number(d.query<{ id: number }, []>('SELECT last_insert_rowid() id').get()!.id)
        d.query('UPDATE port_skip SET pair_id=? WHERE space_id IS NOT NULL').run(other)
      },
    },
    {
      label: 'port_skip.candidate',
      mutate: (d) => d.exec("UPDATE port_skip SET candidate='other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_skip.reason',
      mutate: (d) => d.exec("UPDATE port_skip SET reason='Other' WHERE space_id IS NOT NULL"),
    },
    {
      label: 'port_skip.skipped_at',
      mutate: (d) => d.exec("UPDATE port_skip SET skipped_at='later' WHERE space_id IS NOT NULL"),
    },
  ]
  for (const variation of variations) {
    const database = before()
    try {
      const ids = seedPortTwins(database)
      variation.mutate(database, ids)
      const beforeRows = portRows(database)
      expect(() => applyMigrations(database), variation.label).toThrow(
        'without equivalent hosted twins',
      )
      expect(
        database.query("SELECT name FROM pragma_table_info('port_pair')").all(),
        variation.label,
      ).toContainEqual({ name: 'id' })
      expect(portRows(database), variation.label).toEqual(beforeRows)
    } finally {
      database.close()
    }
  }
}, 30_000)

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
      const foreignKeys = database
        .query<{ from: string }, []>(`PRAGMA foreign_key_list('${table}')`)
        .all()
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
