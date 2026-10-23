import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0153_uuid_primary_keys_k8b1'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ids = {
  project: '01990000-0000-7000-8000-000000001541',
  runA: '01990000-0000-7000-8000-000000001542',
  runB: '01990000-0000-7000-8000-000000001543',
  pair: '01990000-0000-7000-8000-000000001544',
  doc: '01990000-0000-7000-8000-000000001545',
  subject: '01990000-0000-7000-8000-000000001546',
  relatedLegacy: '01990000-0000-7000-8000-000000001547',
  related: '01990000-0000-7000-8000-000000001548',
  audit: '01990000-0000-7000-8000-000000001549',
  ci: '01990000-0000-7000-8000-000000001550',
} as const

function count(database: ReturnType<typeof migrationBoundaryTestDatabase>, table: string): number {
  return (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

test('K8b-1 makes existing UUIDs primary keys without losing row data', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      INSERT INTO project(record_id,name,path,canon,settings)
      VALUES ('${ids.project}','k8b-fixture','/fixture',1,'{}');
      INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('${ids.runA}',1541,'a','codex','test','sha-a',1,'a','ok'),
             ('${ids.runB}',1542,'b','codex','test','sha-b',2,'b','failed');
      INSERT INTO compared_pair(record_id,run_a_record_id,run_b_record_id,compared_at)
      VALUES ('${ids.pair}','${ids.runA}','${ids.runB}','pair-at');
      INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
      VALUES ('${ids.doc}','project','k8b-fixture','k8b-doc','K8b','Body','demand','doc-created','doc-updated','["technical"]');
      INSERT INTO subject(id,project_record_id,name,definition,position,created_at,updated_at)
      VALUES ('${ids.subject}','${ids.project}','Identity','Fixture subject',0,'subject-created','subject-updated');
      INSERT INTO doc_related_subject(id,record_id,doc_record_id,subject_id)
      VALUES ('${ids.relatedLegacy}','${ids.related}','${ids.doc}','${ids.subject}');
      INSERT INTO run_mutation_audit(record_id,run_record_id,root_run_record_id,action,actor_session,at,reason,turn_run_record_id)
      VALUES ('${ids.audit}','${ids.runA}','${ids.runA}','retry','session','audit-at','audit-reason','${ids.runB}');
      INSERT INTO pull_request_ci(record_id,project,project_record_id,pr_number,record_kind,complete,error,recorded_at)
      VALUES ('${ids.ci}','k8b-fixture','${ids.project}',154,'collection',1,'kept-error','ci-at'),
             (NULL,'k8b-fixture','${ids.project}',155,'collection',0,'null-id-error','null-ci-at');
    `)

    const tables = [
      'pull_request_ci',
      'compared_pair',
      'doc_related_subject',
      'run_mutation_audit',
    ] as const
    const beforeCounts = Object.fromEntries(tables.map((table) => [table, count(database, table)]))

    expect(applyMigrations(database)).toContain(MIGRATION)

    for (const table of tables) {
      expect(count(database, table)).toBe(beforeCounts[table]!)
      expect(
        database
          .query<{ name: string; notnull: number; pk: number }, []>(
            `SELECT name,"notnull",pk FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get(),
      ).toEqual({ name: 'record_id', notnull: 1, pk: 1 })
    }
    expect(
      database
        .query(`SELECT record_id,project,project_record_id,pr_number,record_kind,complete,error,
          workflow_run_id,run_attempt,workflow_name,event,head_commit,conclusion,failed_jobs,
          workflow_created_at,workflow_completed_at,recorded_at
          FROM pull_request_ci WHERE pr_number=154`)
        .get(),
    ).toEqual({
      record_id: ids.ci,
      project: 'k8b-fixture',
      project_record_id: ids.project,
      pr_number: 154,
      record_kind: 'collection',
      complete: 1,
      error: 'kept-error',
      workflow_run_id: null,
      run_attempt: null,
      workflow_name: null,
      event: null,
      head_commit: null,
      conclusion: null,
      failed_jobs: null,
      workflow_created_at: null,
      workflow_completed_at: null,
      recorded_at: 'ci-at',
    })
    const repaired = database
      .query<{ record_id: string; error: string }, []>(
        'SELECT record_id,error FROM pull_request_ci WHERE pr_number=155',
      )
      .get()!
    expect(repaired.error).toBe('null-id-error')
    expect(repaired.record_id).toMatch(UUID_V4)
    expect(database.query('SELECT * FROM compared_pair').get()).toEqual({
      record_id: ids.pair,
      run_a_record_id: ids.runA,
      run_b_record_id: ids.runB,
      compared_at: 'pair-at',
    })
    expect(() =>
      database
        .query(
          'INSERT INTO compared_pair(record_id,run_a_record_id,run_b_record_id,compared_at) VALUES (?,?,?,?)',
        )
        .run('01990000-0000-7000-8000-000000001551', ids.runA, ids.runB, 'duplicate'),
    ).toThrow()
    expect(database.query('SELECT * FROM doc_related_subject').get()).toEqual({
      record_id: ids.related,
      doc_record_id: ids.doc,
      subject_id: ids.subject,
    })
    expect(database.query('SELECT * FROM run_mutation_audit').get()).toEqual({
      record_id: ids.audit,
      run_record_id: ids.runA,
      root_run_record_id: ids.runA,
      action: 'retry',
      actor_session: 'session',
      at: 'audit-at',
      reason: 'audit-reason',
      turn_run_record_id: ids.runB,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})
