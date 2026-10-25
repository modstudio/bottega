import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0160_agent_port_baseline_uuid_keys'
const agentRecordId = '01990000-0000-7000-8000-000000001719'
const pairRecordId = '01990000-0000-7000-8000-000000001720'
const baselineRecordId = '01990000-0000-7000-8000-000000001721'

function column(database: Database, table: string, name: string) {
  return database
    .query<{ name: string; notnull: number; pk: number }, []>(
      `SELECT name,"notnull",pk FROM pragma_table_info('${table}') WHERE name='${name}'`,
    )
    .get()
}

function uniqueColumns(database: Database, table: string): string[] {
  return database
    .query<{ name: string }, []>(
      `SELECT column_info.name
       FROM pragma_index_list('${table}') index_list
       JOIN pragma_index_info(index_list.name) column_info
       WHERE index_list."unique"=1
       ORDER BY column_info.name`,
    )
    .all()
    .map((row) => row.name)
}

test('K8b-6 keys agents and port baselines by UUID without losing their values', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      UPDATE agent SET
        record_id='${agentRecordId}', harness='kept-harness', backend='kept-backend',
        model='kept-model', base_url='https://kept.invalid', transport='acp',
        caps='{"readsRepo":true}', billing='metered', operated_by='self', enabled=0,
        disabled_reason='kept-disabled', probed_at='kept-probed',
        probe_result='{"kept":true}', jobs='["implement"]', preferred_jobs='["implement"]',
        max_concurrent=7, api_key_secret='kept-secret-ref', route_metered=1, trains_on_inputs=1
      WHERE name='codex';
      INSERT INTO port_pair(record_id,source_project_record_id,target_project_record_id,created_at,space_id)
      VALUES ('${pairRecordId}','source-project','target-project','pair-at','space');
      INSERT INTO port_baseline(record_id,pair_record_id,source_commit,scanned_at,version,space_id)
      VALUES ('${baselineRecordId}','${pairRecordId}','kept-commit','scan-at',4,'space');
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)

    expect(column(database, 'agent', 'record_id')).toEqual({
      name: 'record_id',
      notnull: 1,
      pk: 1,
    })
    expect(column(database, 'agent', 'name')).toEqual({ name: 'name', notnull: 1, pk: 0 })
    expect(uniqueColumns(database, 'agent')).toEqual(['name', 'record_id'])
    expect(database.query("SELECT * FROM agent WHERE name='codex'").get()).toEqual({
      record_id: agentRecordId,
      name: 'codex',
      harness: 'kept-harness',
      backend: 'kept-backend',
      model: 'kept-model',
      base_url: 'https://kept.invalid',
      transport: 'acp',
      caps: '{"readsRepo":true}',
      billing: 'metered',
      operated_by: 'self',
      enabled: 0,
      disabled_reason: 'kept-disabled',
      probed_at: 'kept-probed',
      probe_result: '{"kept":true}',
      jobs: '["implement"]',
      preferred_jobs: '["implement"]',
      max_concurrent: 7,
      api_key_secret: 'kept-secret-ref',
      route_metered: 1,
      trains_on_inputs: 1,
    })

    expect(column(database, 'port_baseline', 'record_id')).toEqual({
      name: 'record_id',
      notnull: 1,
      pk: 1,
    })
    expect(column(database, 'port_baseline', 'pair_record_id')).toEqual({
      name: 'pair_record_id',
      notnull: 1,
      pk: 0,
    })
    expect(uniqueColumns(database, 'port_baseline')).toEqual(['pair_record_id', 'record_id'])
    expect(database.query('SELECT * FROM port_baseline').get()).toEqual({
      record_id: baselineRecordId,
      pair_record_id: pairRecordId,
      source_commit: 'kept-commit',
      scanned_at: 'scan-at',
      version: 4,
      space_id: 'space',
    })
    expect(
      database
        .query(
          `SELECT "from","table","to",on_update,on_delete
           FROM pragma_foreign_key_list('port_baseline')`,
        )
        .get(),
    ).toEqual({
      from: 'pair_record_id',
      table: 'port_pair',
      to: 'record_id',
      on_update: 'CASCADE',
      on_delete: 'CASCADE',
    })

    database.query('DELETE FROM port_pair WHERE record_id=?').run(pairRecordId)
    expect(database.query('SELECT COUNT(*) count FROM port_baseline').get()).toEqual({ count: 0 })
  } finally {
    database.close()
  }
})

const invalidCases = [
  { table: 'agent', kind: 'NULL', values: "('one','id-one'),('two',NULL)" },
  { table: 'agent', kind: 'duplicate', values: "('one','same-id'),('two','same-id')" },
  {
    table: 'port_baseline',
    kind: 'NULL',
    values:
      "('01990000-0000-7000-8000-000000001722','id-one'),('01990000-0000-7000-8000-000000001723',NULL)",
  },
  {
    table: 'port_baseline',
    kind: 'duplicate',
    values:
      "('01990000-0000-7000-8000-000000001722','same-id'),('01990000-0000-7000-8000-000000001723','same-id')",
  },
] as const

test.each(invalidCases)(
  'K8b-6 refuses $kind $table record ids atomically and leaves the natural primary key',
  ({ table, kind, values }) => {
    const database = migrationBoundaryTestDatabase(MIGRATION)
    try {
      database.exec('PRAGMA foreign_keys=OFF')
      if (table === 'agent') {
        database.exec(`
          DROP TABLE agent;
          CREATE TABLE agent(name TEXT PRIMARY KEY, record_id TEXT);
          INSERT INTO agent(name,record_id) VALUES ${values};
        `)
      } else {
        database.exec(`
          INSERT INTO port_pair(record_id,source_project_record_id,target_project_record_id,created_at)
          VALUES
            ('01990000-0000-7000-8000-000000001722','source-a','target-a','at'),
            ('01990000-0000-7000-8000-000000001723','source-b','target-b','at');
          DROP TABLE port_baseline;
          CREATE TABLE port_baseline(
            pair_record_id TEXT PRIMARY KEY REFERENCES port_pair(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
            record_id TEXT
          );
          INSERT INTO port_baseline(pair_record_id,record_id) VALUES ${values};
        `)
      }

      expect(() => applyMigrations(database)).toThrow(
        `refusing agent/port baseline UUID-key migration: rows have invalid record ids (${table}.record_id ${kind}=1)`,
      )
      expect(database.query(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({ count: 2 })
      expect(column(database, table, table === 'agent' ? 'name' : 'pair_record_id')?.pk).toBe(1)
      expect(
        database.query('SELECT COUNT(*) count FROM orch_migrations WHERE version=?').get(MIGRATION),
      ).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  },
)
