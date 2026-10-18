import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

const MIGRATION = '0117_project_uuid_key'
const RECORD_ID = '01990000-0000-7000-8000-000000001214'
const OTHER_RECORD_ID = '01990000-0000-7000-8000-000000001215'

test('project UUID migration preserves every project child relationship', () => {
  const database = new Database(':memory:')
  try {
    applyMigrationsBefore(database, MIGRATION)
    const project = database
      .query(
        `INSERT INTO project (record_id,name,path,settings)
         VALUES (?,'project-closure','/project-closure','{}') RETURNING id`,
      )
      .get(RECORD_ID) as { id: number }
    const other = database
      .query(
        `INSERT INTO project (record_id,name,path,settings)
         VALUES (?,'other-project','/other-project','{}') RETURNING id`,
      )
      .get(OTHER_RECORD_ID) as { id: number }
    const run = database
      .query(
        `INSERT INTO run
         (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_id)
         VALUES ('run-record','t','codex','implement','sha',1,'prompt','ok','project-closure',?)
         RETURNING id`,
      )
      .get(project.id) as { id: number }
    const doc = database
      .query(
        `INSERT INTO doc
         (record_id,scope,subject,slug,title,body,created_at,updated_at,audiences,project_id)
         VALUES ('doc-record','project','project-closure','doc','Doc','Body','t','t','["technical"]',?)
         RETURNING id`,
      )
      .get(project.id) as { id: number }
    const review = database
      .query(
        `INSERT INTO review (record_id,recorded_at,project_id) VALUES ('review-record','t',?) RETURNING id`,
      )
      .get(project.id) as { id: number }
    database
      .query(
        `INSERT INTO canon_pack
         (record_id,job,project,sha256,bytes,doc_count,doc_revisions,compiled_at,findings,project_id)
         VALUES ('canon-record','implement','project-closure','sha',1,0,'[]','t',0,?)`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO doc_revision
         (record_id,doc_id,scope,subject,slug,op,title,body,author,reason,at,audiences,project_id)
         VALUES ('revision-record',?,'project','project-closure','doc','create','Doc','Body','a','r','t','["technical"]',?)`,
      )
      .run(doc.id, project.id)
    database
      .query(
        `INSERT INTO landing (record_id,project,branch,status,started_at,project_id) VALUES ('landing-record','project-closure','main','queued','t',?)`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO landing_override (record_id,project,branch,tip,tree,reason,at,project_id) VALUES ('override-record','project-closure','main','tip','tree','reason','t',?)`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO landing_review_carry
         (record_id,project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,old_base,new_base,at,project_id)
         VALUES ('carry-record','project-closure','main','tip','tree',?,'commit','tree','patch','old','new','t',?)`,
      )
      .run(review.id, project.id)
    database
      .query(
        `INSERT INTO landing_triage_snapshot
         (record_id,project,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,finding_count,at,project_id)
         VALUES ('snapshot-record','project-closure','main','tip','tree','[]','patch',1,0,0,'t',?)`,
      )
      .run(project.id)
    database
      .query(`INSERT INTO main_stack_activity (project_id,last_ensured_at) VALUES (?,'t')`)
      .run(project.id)
    database
      .query(
        `INSERT INTO port_pair (record_id,source_project_id,target_project_id,created_at) VALUES ('pair-record',?,?, 't')`,
      )
      .run(project.id, other.id)
    database
      .query(
        `INSERT INTO port_ref (record_id,task_key,target_project_id,note,created_at) VALUES ('ref-record','DEV-1',?,'note','t')`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO port_ref_source (record_id,task_key,target_project_id,source_project_id,commits,paths,note) VALUES ('source-record','DEV-1',?,?,'[]','[]','note')`,
      )
      .run(project.id, other.id)
    database
      .query(
        `INSERT INTO project_lens_profile (record_id,project_id,axis,profile_name) VALUES ('profile-record',?,'framework','default')`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO release_ledger (record_id,project,rung,candidate_commit,rollback,actor,started_at,project_id) VALUES ('release-record','project-closure','production','tip',0,'operator','t',?)`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO resource_claim (record_id,root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at) VALUES ('claim-record',?,?,?,'branch','main','claimed','t')`,
      )
      .run(run.id, run.id, project.id)
    database
      .query(
        `INSERT INTO review_read (record_id,project,branch,tip,patch_id,path_set,tier,note,recorded_at,project_id) VALUES ('read-record','project-closure','main','tip','patch','[]',1,'note','t',?)`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO subject (project_id,name,definition,position,created_at,updated_at) VALUES (?,'subject','definition',0,'t','t')`,
      )
      .run(project.id)
    database
      .query(
        `INSERT INTO board_claim
         (project,subject_kind,subject_value,holder_kind,duration_ms,taken_at,renewed_at,lapses_at,record_id)
         VALUES ('other-project','task','DEV-1214','operator',1000,'t','t','later','board-claim-record')`,
      )
      .run()
    database
      .query(
        `INSERT INTO presence
         (session_id,harness,role,machine,project,cwd,last_seen)
         VALUES ('session','codex','architect','machine','project-closure','/project-closure','t')`,
      )
      .run()
    database
      .query(
        `INSERT INTO worker_note_request
         (run_id,text,requested_at,status,project,record_id)
         VALUES (?,'note','t','requested','other-project','worker-note-record')`,
      )
      .run(run.id)
    database
      .query(
        `INSERT INTO workflow_cursor
         (id,project,workflow_slug,mode_slug,workflow_key,instance_id,workflow_version,catalogue_version,
          args,total_steps,created_at,updated_at,record_id)
         VALUES (71,'other-project','workflow','mode','key','instance',1,1,'{}',1,'t','t','cursor-record')`,
      )
      .run()
    database
      .query(
        `INSERT INTO branch_landing_record
         (project,branch,tip,pr_number,merged_at,recorded_at,record_id)
         VALUES ('project-closure','main','tip',12,'t','t','branch-record')`,
      )
      .run()
    database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_project,audience,title,body,ack_required,created_at,expires_at,record_id)
         VALUES ('notice','operator','other-project','operator','title','body',0,'t','later','message-record')`,
      )
      .run()

    expect(applyMigrations(database)).toContain(MIGRATION)
    const columns = [
      ['run', 'project_record_id', RECORD_ID],
      ['canon_pack', 'project_record_id', RECORD_ID],
      ['doc', 'project_record_id', RECORD_ID],
      ['doc_revision', 'project_record_id', RECORD_ID],
      ['landing', 'project_record_id', RECORD_ID],
      ['landing_override', 'project_record_id', RECORD_ID],
      ['landing_review_carry', 'project_record_id', RECORD_ID],
      ['landing_triage_snapshot', 'project_record_id', RECORD_ID],
      ['main_stack_activity', 'project_record_id', RECORD_ID],
      ['port_pair', 'source_project_record_id', RECORD_ID],
      ['port_pair', 'target_project_record_id', OTHER_RECORD_ID],
      ['port_ref', 'target_project_record_id', RECORD_ID],
      ['port_ref_source', 'source_project_record_id', OTHER_RECORD_ID],
      ['port_ref_source', 'target_project_record_id', RECORD_ID],
      ['project_lens_profile', 'project_record_id', RECORD_ID],
      ['release_ledger', 'project_record_id', RECORD_ID],
      ['resource_claim', 'project_record_id', RECORD_ID],
      ['review', 'project_record_id', RECORD_ID],
      ['review_read', 'project_record_id', RECORD_ID],
      ['subject', 'project_record_id', RECORD_ID],
      ['board_claim', 'project_record_id', OTHER_RECORD_ID],
      ['presence', 'project_record_id', RECORD_ID],
      ['worker_note_request', 'project_record_id', OTHER_RECORD_ID],
      ['workflow_cursor', 'project_record_id', OTHER_RECORD_ID],
      ['branch_landing_record', 'project_record_id', RECORD_ID],
      ['board_message', 'author_project_record_id', OTHER_RECORD_ID],
    ] as const
    for (const [table, column, expected] of columns)
      expect(database.query(`SELECT ${column} AS id FROM ${table}`).get()).toEqual({ id: expected })
    expect(database.query("PRAGMA table_info('project')").all()).not.toContainEqual(
      expect.objectContaining({ name: 'id' }),
    )
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})
