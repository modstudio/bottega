import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore, migrationJournal } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

function pendingMigrationsFrom(tag: string): string[] {
  const journal = migrationJournal()
  return journal.slice(journal.findIndex((entry) => entry.tag === tag)).map((entry) => entry.tag)
}

test('task rulings migration applies cleanly and preserves mutation audit rows', () => {
  const database = migrationBoundaryTestDatabase('0050_task_rulings')
  try {
    const run = database
      .query(
        `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('${newRecordId()}','2026-09-20','codex','implement','sha',1,'prompt','ok') RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO run_mutation_audit (run_id,root_id,action,actor_session,at,reason)
         VALUES (?,?,'answer','owner','2026-09-21','because')`,
      )
      .run(run.id, run.id)

    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0050_task_rulings'))
    expect(database.query('SELECT action,reason FROM run_mutation_audit').get()).toEqual({
      action: 'answer',
      reason: 'because',
    })
    const runRecordId = (
      database.query('SELECT record_id FROM run WHERE number=?').get(run.id) as {
        record_id: string
      }
    ).record_id
    expect(() =>
      database
        .query(
          `INSERT INTO run_mutation_audit (record_id,run_record_id,root_run_record_id,action,at)
           VALUES (?,?,?,'overturn','2026-09-22')`,
        )
        .run(newRecordId(), runRecordId, runRecordId),
    ).not.toThrow()
    expect(() =>
      database
        .query(
          `INSERT INTO run_mutation_audit (record_id,run_record_id,root_run_record_id,action,at)
           VALUES (?,?,?,'file','2026-09-23')`,
        )
        .run(newRecordId(), runRecordId, runRecordId),
    ).not.toThrow()
    expect(
      database
        .query(`SELECT name FROM pragma_table_info('question') WHERE name LIKE 'overturn%'`)
        .all(),
    ).toHaveLength(3)
    expect(
      database
        .query(`SELECT name FROM pragma_table_info('question') WHERE name LIKE 'filed_%'`)
        .all(),
    ).toEqual([
      { name: 'filed_as' },
      { name: 'filed_ref' },
      { name: 'filed_at' },
      { name: 'filed_record_id' },
      { name: 'filed_label' },
    ])
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='run_carried_ruling'")
        .get(),
    ).toEqual({ name: 'run_carried_ruling' })
    expect(
      database
        .query(
          "SELECT name FROM pragma_table_info('run_mutation_audit') WHERE name='turn_run_record_id'",
        )
        .get(),
    ).toEqual({ name: 'turn_run_record_id' })
  } finally {
    database.close()
  }
})

test('agent operator migration preserves cost facts and the routing free set', () => {
  const database = migrationBoundaryTestDatabase('0039_agent_operator')
  try {
    const insert = database.query(
      `INSERT INTO agent (name,harness,backend,model,transport,caps,billing,enabled)
       VALUES (?,?, 'vendor', 'model', 'cli', '{}', ?, 1)`,
    )
    insert.run('unexpected-free', 'codex', 'free')
    insert.run('unexpected-local', 'goose', 'local')
    insert.run('unexpected-unknown', 'codex', 'unknown')
    const before = database
      .query("SELECT name FROM agent WHERE billing IN ('free','local') ORDER BY name")
      .all()
    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0039_agent_operator'))
    const after = database
      .query("SELECT name FROM agent WHERE billing IN ('free','none') ORDER BY name")
      .all()
    expect(after).toEqual(before)
    expect(
      database
        .query(
          "SELECT name,billing,operated_by FROM agent WHERE name LIKE 'unexpected-%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: 'unexpected-free', billing: 'free', operated_by: 'vendor' },
      { name: 'unexpected-local', billing: 'none', operated_by: 'self' },
      { name: 'unexpected-unknown', billing: 'unknown', operated_by: 'vendor' },
    ])
  } finally {
    database.close()
  }
})

test('project task identity migration backfills ledger project relationships', () => {
  const database = migrationBoundaryTestDatabase('0047_project_task_identity')
  try {
    const project = database
      .query(
        `INSERT INTO project (name,path,canon,settings) VALUES ('target','/target',1,'{}')
         RETURNING id`,
      )
      .get() as { id: number }
    const source = database
      .query(
        `INSERT INTO project (name,path,canon,settings) VALUES ('source','/source',1,'{}')
         RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO port_ref (task_key,target_project_id,note,created_at)
         VALUES ('SHARED-1',?,'note','2026-01-01')`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO port_ref_source (task_key,source_project_id,commits,paths,note)
         VALUES ('SHARED-1',?,'[]','[]','source')`,
      )
      .run(source.id)

    expect(applyMigrationsBefore(database, '0048_user_canon_owner')).toEqual([
      '0047_project_task_identity',
    ])
    expect(database.query('SELECT * FROM port_ref_source').get()).toMatchObject({
      task_key: 'SHARED-1',
      target_project_id: project.id,
      source_project_id: source.id,
    })
  } finally {
    database.close()
  }
})

test('user canon owner migration preserves docs and enforces owner addresses', () => {
  const database = migrationBoundaryTestDatabase('0048_user_canon_owner')
  try {
    database
      .query(
        `INSERT INTO doc
          (id,scope,subject,slug,title,body,delivery,created_at,updated_at,record_id)
         VALUES (1,'canon',NULL,'.agents/rules/existing.md','Existing','body','inject',
           '2026-01-01','2026-01-01','record-doc')`,
      )
      .run()
    database
      .query(
        `INSERT INTO doc_revision
          (id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,record_id)
         VALUES (1,1,'canon',NULL,'.agents/rules/existing.md','create','Existing','body','inject',
           'operator','preserve existing row','2026-01-01','record-revision')`,
      )
      .run()

    expect(applyMigrationsBefore(database, '0049_operator_waiting')).toEqual([
      '0048_user_canon_owner',
    ])
    expect(database.query('SELECT title, record_id, owner FROM doc WHERE id=1').get()).toEqual({
      title: 'Existing',
      record_id: 'record-doc',
      owner: null,
    })
    expect(
      database.query('SELECT reason, record_id, owner FROM doc_revision WHERE id=1').get(),
    ).toEqual({
      reason: 'preserve existing row',
      record_id: 'record-revision',
      owner: null,
    })

    const insertDoc = database.query(
      `INSERT INTO doc
        (scope,subject,slug,title,body,delivery,created_at,updated_at,owner,record_id)
       VALUES (?,?,?,?,?,'inject','2026-01-02','2026-01-02','user-1','invalid-owner-test')`,
    )
    expect(() => insertDoc.run('project', 'target', 'private', 'Private', 'body')).toThrow()
    expect(() =>
      insertDoc.run('canon', 'target', '.agents/rules/private.md', 'Private', 'body'),
    ).toThrow()

    const insertRevision = database.query(
      `INSERT INTO doc_revision
        (doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,owner)
       VALUES (1,?,?,?,'set','Private','body','inject','operator','reject invalid row',
         '2026-01-02','user-1')`,
    )
    expect(() => insertRevision.run('project', 'target', 'private')).toThrow()
    expect(() => insertRevision.run('canon', 'target', '.agents/rules/private.md')).toThrow()
  } finally {
    database.close()
  }
})
