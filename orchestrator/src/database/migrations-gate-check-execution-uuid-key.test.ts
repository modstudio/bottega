import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0158_gate_check_execution_uuid_keys'
const gateRecordId = '01990000-0000-7000-8000-000000001699'
const checkRecordId = '01990000-0000-7000-8000-000000001700'

test('K8b-4 keys gate and check executions by UUID and rewrites gate evidence', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec('PRAGMA foreign_keys=OFF')
    database.exec(`
      INSERT INTO workflow(record_id,slug,created_at)
      VALUES ('01990000-0000-7000-8000-000000001706','fixture','at');
      INSERT INTO workflow_version(record_id,workflow_record_id,n,status,definition,author,reason,created_at)
      VALUES ('01990000-0000-7000-8000-000000001707','01990000-0000-7000-8000-000000001706',1,'production','{}','author','reason','at');
      INSERT INTO step_catalogue(record_id,slug,created_at)
      VALUES ('01990000-0000-7000-8000-000000001708','shared','at');
      INSERT INTO step_catalogue_version(record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
      VALUES ('01990000-0000-7000-8000-000000001709','01990000-0000-7000-8000-000000001708',1,'production','{}','author','reason','at');
      INSERT INTO workflow_cursor(
        record_id,number,project,workflow_slug,mode_slug,instance_id,workflow_version_record_id,
        catalogue_version_record_id,args,total_steps,created_at,updated_at
      ) VALUES (
        '01990000-0000-7000-8000-000000001702',1,'fixture','fixture','mode','instance',
        '01990000-0000-7000-8000-000000001707','01990000-0000-7000-8000-000000001709','{}',1,'at','at'
      );
      INSERT INTO gate_execution(
        id,record_id,requested_at,started_at,finished_at,exit_code,timed_out,elapsed_ms,
        output_tail,output_artifact,cancelled_reason,tooling_paths,resolved_command,head_commit,
        session_id,cwd,base_refresh_elapsed_ms,base_refresh_result
      ) VALUES (
        7,'${gateRecordId}','requested','started','finished',0,0,42,'tail','artifact','reason',
        '["tool"]','command','head','session','/cwd',8,'refresh'
      );
      INSERT INTO check_execution(
        id,record_id,gate_execution_id,check_name,category,wall_ms,cpu_ms,exit_code,remaining_count
      ) VALUES (9,'${checkRecordId}',7,'kept-check','kept-category',12.5,3.5,0,4);
      INSERT INTO workflow_obligation(
        record_id,cursor_record_id,step_ordinal,step_slug,floor,reason,created_at,satisfied_evidence
      ) VALUES
        ('01990000-0000-7000-8000-000000001701','01990000-0000-7000-8000-000000001702',1,'one','command-exit','reason','at','[{"flag":"--gate","value":"7"}]'),
        ('01990000-0000-7000-8000-000000001703','01990000-0000-7000-8000-000000001702',2,'two','command-exit','reason','at','[{"flag":"--gate","value":"404"}]');
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)
    for (const table of ['gate_execution', 'check_execution']) {
      expect(
        database
          .query<{ name: string; notnull: number; pk: number }, []>(
            `SELECT name,"notnull",pk FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get(),
      ).toEqual({ name: 'record_id', notnull: 1, pk: 1 })
      expect(
        database.query(`SELECT name FROM pragma_table_info('${table}') WHERE name='id'`).get(),
      ).toBeNull()
      expect(database.query(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({ count: 1 })
    }
    expect(database.query('SELECT * FROM gate_execution').get()).toMatchObject({
      record_id: gateRecordId,
      number: 7,
      output_tail: 'tail',
      tooling_paths: '["tool"]',
      base_refresh_result: 'refresh',
    })
    expect(database.query('SELECT * FROM check_execution').get()).toEqual({
      record_id: checkRecordId,
      gate_execution_record_id: gateRecordId,
      check_name: 'kept-check',
      category: 'kept-category',
      wall_ms: 12.5,
      cpu_ms: 3.5,
      exit_code: 0,
      remaining_count: 4,
    })
    expect(
      database
        .query('SELECT "from","table","to" FROM pragma_foreign_key_list(\'check_execution\')')
        .get(),
    ).toEqual({
      from: 'gate_execution_record_id',
      table: 'gate_execution',
      to: 'record_id',
    })
    expect(
      database
        .query('SELECT satisfied_evidence FROM workflow_obligation ORDER BY step_ordinal')
        .all(),
    ).toEqual([
      { satisfied_evidence: `[{"flag":"--gate","value":"${gateRecordId}"}]` },
      { satisfied_evidence: '[{"flag":"--gate","value":"404"}]' },
    ])

    database.exec("DELETE FROM entity_number_counter WHERE entity='gate_execution'")
    expect(() =>
      database.exec(
        "INSERT INTO gate_execution(record_id,requested_at) VALUES ('01990000-0000-7000-8000-000000001704','at')",
      ),
    ).toThrow('gate execution number counter is missing')
  } finally {
    database.close()
  }
})

test('K8b-4 refuses an orphaned check execution instead of dropping it', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec('PRAGMA foreign_keys=OFF')
    database.exec(`
      INSERT INTO check_execution(id,record_id,gate_execution_id,check_name,wall_ms,exit_code)
      VALUES (91,'01990000-0000-7000-8000-000000001705',404,'orphan',1,1)
    `)
    expect(() => applyMigrations(database)).toThrow(
      'refusing gate/check execution UUID-key migration: integer references have no parent gate execution (check_execution.gate_execution_record_id=1)',
    )
    expect(database.query('SELECT COUNT(*) count FROM check_execution').get()).toEqual({ count: 1 })
  } finally {
    database.close()
  }
})
