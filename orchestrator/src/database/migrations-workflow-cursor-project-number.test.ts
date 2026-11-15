import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0226_workflow_cursor_project_number'

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
      3,
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
      5,
      'project-a',
      'project-a',
      'fixture',
      'A-SECOND',
      'workflow-version-id',
      'catalogue-version-id',
      '2026-11-15T01:00:00Z',
      '2026-11-15T01:00:00Z',
    )

    const recordIds = database
      .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor ORDER BY record_id')
      .all()
    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(
      database
        .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor ORDER BY record_id')
        .all(),
    ).toEqual(recordIds)
    expect(
      database
        .query<{ project: string; record_id: string; number: number }, []>(
          'SELECT project,record_id,number FROM workflow_cursor ORDER BY project,number',
        )
        .all(),
    ).toEqual([
      { project: 'project-a', record_id: 'stage-a-first', number: 1 },
      { project: 'project-a', record_id: 'stage-a-second', number: 2 },
      { project: 'project-a', record_id: 'stage-a-late', number: 3 },
      { project: 'project-b', record_id: 'stage-b-first', number: 1 },
      { project: 'project-b', record_id: 'stage-b-second', number: 2 },
    ])
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() =>
      database
        .query("UPDATE workflow_cursor SET number=1 WHERE record_id='stage-b-second'")
        .run(),
    ).toThrow()
  } finally {
    database.close()
  }
})
