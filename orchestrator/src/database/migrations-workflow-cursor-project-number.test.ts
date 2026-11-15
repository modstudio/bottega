import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0227_workflow_cursor_project_number'

test('workflow cursor project-number migration preserves identities and renumbers each project densely', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      INSERT INTO project(record_id,name,path,stack,settings) VALUES
        ('project-a','project-a','/project-a','bun','{}'),
        ('project-b','project-b','/project-b','bun','{}');
      INSERT INTO workflow(record_id,slug,created_at)
        VALUES ('workflow-id','fixture','2026-11-15');
      INSERT INTO workflow_version
        (record_id,workflow_record_id,n,status,definition,author,reason,created_at)
        VALUES ('workflow-version-id','workflow-id',1,'production','{}','test','fixture','2026-11-15');
      INSERT INTO step_catalogue(record_id,slug,created_at)
        VALUES ('catalogue-id','shared','2026-11-15');
      INSERT INTO step_catalogue_version
        (record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
        VALUES ('catalogue-version-id','catalogue-id',1,'production','{}','test','fixture','2026-11-15');
    `)
    const insert = database.query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at)
       VALUES (?,?,?,?,?,'default',?,'',?,?,'{}',1,?,?)`,
    )
    insert.run(
      'stage-a-late',
      1,
      'project-a',
      'project-a',
      'fixture',
      'A-LATE',
      'workflow-version-id',
      'catalogue-version-id',
      '2026-11-15T03:00:00Z',
      '2026-11-15T03:00:00Z',
    )
    insert.run(
      'stage-b-first',
      2,
      'project-b',
      'project-b',
      'fixture',
      'B-FIRST',
      'workflow-version-id',
      'catalogue-version-id',
      '2026-11-15T01:00:00Z',
      '2026-11-15T01:00:00Z',
    )
    insert.run(
      'stage-a-first',
      5,
      'project-a',
      'project-a',
      'fixture',
      'A-FIRST',
      'workflow-version-id',
      'catalogue-version-id',
      '2026-11-15T01:00:00Z',
      '2026-11-15T01:00:00Z',
    )
    insert.run(
      'stage-b-second',
      4,
      'project-b',
      'project-b',
      'fixture',
      'B-SECOND',
      'workflow-version-id',
      'catalogue-version-id',
      '2026-11-15T03:00:00Z',
      '2026-11-15T03:00:00Z',
    )
    insert.run(
      'stage-a-second',
      3,
      'project-a',
      'project-a',
      'fixture',
      'A-SECOND',
      'workflow-version-id',
      'catalogue-version-id',
      '2026-11-15T01:00:00Z',
      '2026-11-15T01:00:00Z',
    )

    database.exec(`
      INSERT INTO workflow_obligation
        (record_id,cursor_record_id,step_ordinal,step_slug,floor,reason,created_at)
        VALUES ('obligation-id','stage-a-first',1,'build','test','fixture','2026-11-15');
      INSERT INTO workflow_step_text
        (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
        VALUES ('text-id','stage-a-first',1,'build','proof text','2026-11-15');
      INSERT INTO workflow_text_copy
        (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at)
        VALUES ('copy-id','text-id','stage-a-first','task:DEV-2329','2026-11-15');
      INSERT INTO question
        (record_id,number,workflow_cursor_record_id,asked_at,question)
        VALUES ('question-id',1,'stage-a-first','2026-11-15','Which?');
      INSERT INTO task_flow
        (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at)
        VALUES ('flow-id','task-id','project-a','open','stage-a-first','2026-11-15','2026-11-15');
    `)

    const recordIds = database
      .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor ORDER BY record_id')
      .all()
    const dependents = [
      'workflow_obligation',
      'workflow_step_text',
      'workflow_text_copy',
      'question',
      'task_flow',
    ] as const
    const dependentRows = new Map(
      dependents.map((table) => [table, database.query(`SELECT * FROM ${table}`).all()]),
    )
    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(
      database
        .query<{ record_id: string }, []>(
          'SELECT record_id FROM workflow_cursor ORDER BY record_id',
        )
        .all(),
    ).toEqual(recordIds)
    expect(
      database
        .query<{ project: string; record_id: string; number: number }, []>(
          'SELECT project,record_id,number FROM workflow_cursor ORDER BY project,number',
        )
        .all(),
    ).toEqual([
      { project: 'project-a', record_id: 'stage-a-second', number: 1 },
      { project: 'project-a', record_id: 'stage-a-first', number: 2 },
      { project: 'project-a', record_id: 'stage-a-late', number: 3 },
      { project: 'project-b', record_id: 'stage-b-first', number: 1 },
      { project: 'project-b', record_id: 'stage-b-second', number: 2 },
    ])
    for (const table of dependents) {
      expect(database.query(`SELECT * FROM ${table}`).all()).toEqual(dependentRows.get(table)!)
    }
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() =>
      database.query("UPDATE workflow_cursor SET number=1 WHERE record_id='stage-b-second'").run(),
    ).toThrow()

    database
      .query(
        `INSERT INTO workflow_cursor
         (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
          workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at)
         VALUES ('stage-a-backdated',4,'project-a','project-a','fixture','default','A-BACKDATED','',
                 'workflow-version-id','catalogue-version-id','{}',1,
                 '2026-11-15T00:00:00Z','2026-11-15T04:00:00Z')`,
      )
      .run()
    const numbersBeforeRerun = database
      .query<{ record_id: string; number: number }, []>(
        'SELECT record_id,number FROM workflow_cursor ORDER BY record_id',
      )
      .all()
    applyMigrations(database)
    expect(
      database
        .query<{ record_id: string; number: number }, []>(
          'SELECT record_id,number FROM workflow_cursor ORDER BY record_id',
        )
        .all(),
    ).toEqual(numbersBeforeRerun)
  } finally {
    database.close()
  }
})
