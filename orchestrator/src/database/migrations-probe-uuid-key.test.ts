import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0159_probe_uuid_key'
const probeRecordId = '01990000-0000-7000-8000-000000001708'

test('K8b-5 keys probes by UUID, preserves their display numbers, and rewrites evidence', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      INSERT INTO workflow(record_id,slug,created_at)
      VALUES ('01990000-0000-7000-8000-000000001709','fixture','at');
      INSERT INTO workflow_version(record_id,workflow_record_id,n,status,definition,author,reason,created_at)
      VALUES ('01990000-0000-7000-8000-000000001710','01990000-0000-7000-8000-000000001709',1,'production','{}','author','reason','at');
      INSERT INTO step_catalogue(record_id,slug,created_at)
      VALUES ('01990000-0000-7000-8000-000000001711','shared','at');
      INSERT INTO step_catalogue_version(record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
      VALUES ('01990000-0000-7000-8000-000000001712','01990000-0000-7000-8000-000000001711',1,'production','{}','author','reason','at');
      INSERT INTO workflow_cursor(
        record_id,number,project,workflow_slug,mode_slug,instance_id,workflow_version_record_id,
        catalogue_version_record_id,args,total_steps,created_at,updated_at
      ) VALUES (
        '01990000-0000-7000-8000-000000001713',1,'fixture','fixture','mode','instance',
        '01990000-0000-7000-8000-000000001710','01990000-0000-7000-8000-000000001712','{}',3,'at','at'
      );
      INSERT INTO probe(
        id,record_id,command,cwd,head_commit,exit_code,output_tail,withheld,session_id,
        created_at,kind,command_withheld,pre_command_head_commit
      ) VALUES (
        7,'${probeRecordId}','["kept"]','/cwd','head',0,'tail',1,'session',
        'created','exec',1,'before'
      );
      UPDATE sqlite_sequence SET seq=11 WHERE name='probe';
      INSERT INTO workflow_obligation(
        record_id,cursor_record_id,step_ordinal,step_slug,floor,reason,created_at,satisfied_evidence
      ) VALUES
        ('01990000-0000-7000-8000-000000001714','01990000-0000-7000-8000-000000001713',1,'one','command-exit','reason','at','[{"flag":"--artifact","value":"exec:7"}]'),
        ('01990000-0000-7000-8000-000000001715','01990000-0000-7000-8000-000000001713',2,'two','recorded-artifact','reason','at','[{"flag":"--artifact","value":"probe:7"}]'),
        ('01990000-0000-7000-8000-000000001716','01990000-0000-7000-8000-000000001713',3,'three','recorded-artifact','reason','at','[{"flag":"--artifact","value":"probe:404"}]');
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(
      database
        .query<{ name: string; notnull: number; pk: number }, []>(
          `SELECT name,"notnull",pk FROM pragma_table_info('probe') WHERE name='record_id'`,
        )
        .get(),
    ).toEqual({ name: 'record_id', notnull: 1, pk: 1 })
    expect(
      database.query("SELECT name FROM pragma_table_info('probe') WHERE name='id'").get(),
    ).toBeNull()
    expect(database.query('SELECT * FROM probe').get()).toMatchObject({
      record_id: probeRecordId,
      number: 7,
      command: '["kept"]',
      cwd: '/cwd',
      head_commit: 'head',
      exit_code: 0,
      output_tail: 'tail',
      withheld: 1,
      session_id: 'session',
      created_at: 'created',
      kind: 'exec',
      command_withheld: 1,
      pre_command_head_commit: 'before',
    })
    expect(
      database
        .query<{ name: string; unique: number; origin: string; partial: number }, []>(
          `SELECT name,"unique",origin,partial FROM pragma_index_list('probe') ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: 'sqlite_autoindex_probe_1', unique: 1, origin: 'pk', partial: 0 },
      { name: 'sqlite_autoindex_probe_2', unique: 1, origin: 'u', partial: 0 },
    ])
    expect(
      database
        .query('SELECT satisfied_evidence FROM workflow_obligation ORDER BY step_ordinal')
        .all(),
    ).toEqual([
      { satisfied_evidence: `[{"flag":"--artifact","value":"exec:${probeRecordId}"}]` },
      { satisfied_evidence: `[{"flag":"--artifact","value":"probe:${probeRecordId}"}]` },
      { satisfied_evidence: '[{"flag":"--artifact","value":"probe:404"}]' },
    ])
    database.exec(`
      INSERT INTO probe(record_id,command,cwd,exit_code,output_tail,created_at)
      VALUES ('01990000-0000-7000-8000-000000001717','[]','/cwd',0,'','later')
    `)
    expect(
      database
        .query<{ number: number }, []>(
          "SELECT number FROM probe WHERE record_id='01990000-0000-7000-8000-000000001717'",
        )
        .get(),
    ).toEqual({ number: 12 })

    database.exec("DELETE FROM entity_number_counter WHERE entity='probe'")
    expect(() =>
      database.exec(
        "INSERT INTO probe(record_id,command,cwd,exit_code,output_tail,created_at) VALUES ('01990000-0000-7000-8000-000000001718','[]','/cwd',0,'','later')",
      ),
    ).toThrow('probe number counter is missing')
  } finally {
    database.close()
  }
})
