import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0156_monitor_release_claim_uuid_keys'
const ids = {
  run: '01990000-0000-7000-8000-000000001694',
  project: '01990000-0000-7000-8000-000000001695',
  invocation: '01990000-0000-7000-8000-000000001696',
  condition: '01990000-0000-7000-8000-000000001697',
  release: '01990000-0000-7000-8000-000000001698',
  claim: '01990000-0000-7000-8000-000000001699',
} as const

test('K8b-3 keys monitor, release, and claim rows by UUID without losing their data', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      INSERT INTO project(record_id,name,path,stack,settings,canon)
      VALUES ('${ids.project}','kept-project','/kept/project','node','{}',1);
      INSERT INTO run(record_id,number,project_record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('${ids.run}',1694,'${ids.project}','run-at','codex','implement','sha',1,'prompt','running');
      INSERT INTO monitor_invocation(id,record_id,started_at,finished_at,trigger,findings,errors,host_load)
      VALUES (41,'${ids.invocation}','invocation-at','invocation-finished','backstop',7,2,'{"load":1}');
      INSERT INTO monitor_condition(
        id,record_id,invocation_id,kind,subject,condition_since,age_ms,detail,action,issue_key,
        severity,owner_session_id,delivered_at
      ) VALUES (
        51,'${ids.condition}',41,'kept-kind','kept-subject','condition-at',123,'kept-detail',
        'kept-action','DEV-7','attention','kept-owner','delivered-at'
      );
      INSERT INTO release_ledger(
        id,record_id,project,project_record_id,rung,candidate_commit,live_commit_before,rollback,
        rollback_reason,actor,session_id,started_at,finished_at,exit_code,output_tail,
        live_commit_after,live_matches_candidate,warning,trunk,trunk_tip,commits_behind_trunk,
        behind_trunk_reason
      ) VALUES (
        61,'${ids.release}','kept-project','${ids.project}','production','candidate','before',1,
        'kept-reason','kept-actor','kept-session','release-at','release-finished',0,'kept-output',
        'after',1,'kept-warning','main','trunk-tip',3,'kept-behind-reason'
      );
      INSERT INTO resource_claim(
        id,record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,settled_at,settled_detail
      ) VALUES (
        71,'${ids.claim}','${ids.run}','${ids.run}','${ids.project}','worktree','/kept/tree',
        'kept-identity','kept-label','released','claim-at','settled-at','kept-settlement'
      );
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)

    for (const table of [
      'monitor_invocation',
      'monitor_condition',
      'release_ledger',
      'resource_claim',
    ]) {
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
    expect(database.query('SELECT * FROM monitor_invocation').get()).toEqual({
      record_id: ids.invocation,
      number: 41,
      started_at: 'invocation-at',
      finished_at: 'invocation-finished',
      trigger: 'backstop',
      findings: 7,
      errors: 2,
      host_load: '{"load":1}',
    })
    expect(database.query('SELECT * FROM monitor_condition').get()).toEqual({
      record_id: ids.condition,
      number: 51,
      invocation_record_id: ids.invocation,
      kind: 'kept-kind',
      subject: 'kept-subject',
      condition_since: 'condition-at',
      age_ms: 123,
      detail: 'kept-detail',
      action: 'kept-action',
      issue_key: 'DEV-7',
      severity: 'attention',
      owner_session_id: 'kept-owner',
      delivered_at: 'delivered-at',
    })
    expect(database.query('SELECT * FROM release_ledger').get()).toMatchObject({
      record_id: ids.release,
      number: 61,
      project: 'kept-project',
      project_record_id: ids.project,
      output_tail: 'kept-output',
      trunk_tip: 'trunk-tip',
      commits_behind_trunk: 3,
    })
    expect(database.query('SELECT * FROM resource_claim').get()).toEqual({
      record_id: ids.claim,
      number: 71,
      root_run_record_id: ids.run,
      run_record_id: ids.run,
      project_record_id: ids.project,
      kind: 'worktree',
      allocation_key: '/kept/tree',
      identity: 'kept-identity',
      label: 'kept-label',
      state: 'released',
      claimed_at: 'claim-at',
      settled_at: 'settled-at',
      settled_detail: 'kept-settlement',
    })
    expect(
      database
        .query('SELECT "from","table","to" FROM pragma_foreign_key_list(\'monitor_condition\')')
        .get(),
    ).toEqual({ from: 'invocation_record_id', table: 'monitor_invocation', to: 'record_id' })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])

    database.exec(
      "DELETE FROM entity_number_counter WHERE entity IN ('monitor_invocation','monitor_condition','release_ledger','resource_claim')",
    )
    for (const statement of [
      `INSERT INTO monitor_invocation(record_id,started_at,trigger) VALUES ('01990000-0000-7000-8000-000000001700','at','invoked')`,
      `INSERT INTO release_ledger(record_id,project,rung,candidate_commit,rollback,actor,started_at) VALUES ('01990000-0000-7000-8000-000000001701','p','r','c',0,'a','at')`,
      `INSERT INTO resource_claim(record_id,root_run_record_id,run_record_id,kind,allocation_key,state,claimed_at) VALUES ('01990000-0000-7000-8000-000000001702','${ids.run}','${ids.run}','branch','ref', 'claimed','at')`,
    ]) {
      expect(() => database.exec(statement)).toThrow('number counter is missing')
    }
  } finally {
    database.close()
  }
})

test('K8b-3 refuses an orphaned monitor condition instead of dropping it', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec('PRAGMA foreign_keys=OFF')
    database.exec(`
      INSERT INTO monitor_condition(
        id,record_id,invocation_id,kind,subject,detail,action
      ) VALUES (91,'01990000-0000-7000-8000-000000001703',404,'orphan','orphan','detail','action')
    `)
    expect(() => applyMigrations(database)).toThrow(
      'refusing monitor UUID-key migration: integer references have no parent monitor invocation (monitor_condition.invocation_record_id=1)',
    )
    expect(database.query('SELECT COUNT(*) count FROM monitor_condition').get()).toEqual({
      count: 1,
    })
  } finally {
    database.close()
  }
})
