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

test('K8b-6 refuses a NULL agent name by record id and leaves the old schema intact', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  const nullNameRecordId = '01990000-0000-7000-8000-000000001722'
  try {
    database
      .query(
        `INSERT INTO agent(
           record_id,name,harness,model,transport,caps,billing,operated_by,enabled
         ) VALUES (?,NULL,'claude','kept-model','cli','{}','subscription','vendor',1)`,
      )
      .run(nullNameRecordId)

    expect(() => applyMigrations(database)).toThrow(
      `refusing agent/port baseline UUID-key migration: rows have invalid identities (agent.name NULL=1 record_ids=${nullNameRecordId})`,
    )
    expect(
      database.query('SELECT record_id,name FROM agent WHERE record_id=?').get(nullNameRecordId),
    ).toEqual({ record_id: nullNameRecordId, name: null })
    expect(column(database, 'agent', 'name')).toEqual({ name: 'name', notnull: 0, pk: 1 })
    expect(
      database.query('SELECT COUNT(*) count FROM orch_migrations WHERE version=?').get(MIGRATION),
    ).toEqual({ count: 0 })
  } finally {
    database.close()
  }
})
