import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../database/migrations.ts'
import {
  orchestratorProjectPurgePlan,
  purgeLocalOrchestratorProject,
  uncoveredOrchestratorProjectTables,
} from './project-purge-local.ts'

const TARGET = '00000000-0000-7000-8000-000000000101'
const SIBLING = '00000000-0000-7000-8000-000000000102'

test('the live orchestrator schema has no uncovered project-bearing table', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  expect(uncoveredOrchestratorProjectTables(database)).toEqual([])
  const tables = orchestratorProjectPurgePlan(database).map(({ table }) => table)
  for (const table of [
    'run',
    'score',
    'question',
    'run_message',
    'review_finding',
    'port_pair',
    'port_ref',
    'port_ref_source',
    'project_lens_profile',
    'board_reach_delivery',
    'outbox',
  ])
    expect(tables).toContain(table)
  database.close()
})

test('orchestrator purge removes a populated project without touching its sibling or hosted cache', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.exec('PRAGMA foreign_keys=ON')
  const runsDirectory = mkdtempSync(join(tmpdir(), 'bottega-project-purge-'))
  try {
    database
      .query('INSERT INTO project(record_id,name,path) VALUES (?,?,?)')
      .run(TARGET, 'target', '/target')
    database
      .query('INSERT INTO project(record_id,name,path) VALUES (?,?,?)')
      .run(SIBLING, 'sibling', '/sibling')

    const insertRun = database.query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,?,?,?,?,'sha',1,'prompt','ok',?)`,
    )
    insertRun.run('run-target', 1, 'at', 'agent', 'job', TARGET)
    insertRun.run('run-target-missing-folder', 2, 'at', 'agent', 'job', TARGET)
    insertRun.run('run-sibling', 3, 'at', 'agent', 'job', SIBLING)
    mkdirSync(join(runsDirectory, 'run-target'))
    mkdirSync(join(runsDirectory, 'run-sibling'))

    const insertScore = database.query(
      `INSERT INTO score(record_id,run_record_id,delivery,quality,scored_at) VALUES (?,?,?,'right',?)`,
    )
    insertScore.run('score-target', 'run-target', 'full', 'at')
    insertScore.run('score-sibling', 'run-sibling', 'full', 'at')
    const insertQuestion = database.query(
      'INSERT INTO question(record_id,number,run_record_id,asked_at,question) VALUES (?,?,?,?,?)',
    )
    insertQuestion.run('question-target', 1, 'run-target', 'at', 'target?')
    insertQuestion.run('question-sibling', 2, 'run-sibling', 'at', 'sibling?')
    const insertMessage = database.query(
      `INSERT INTO run_message
       (record_id,direction,root_run_record_id,run_record_id,body,created_at,delivery)
       VALUES (?,?,?,?,?,?,?)`,
    )
    insertMessage.run(
      'message-target',
      'from_worker',
      'run-target',
      'run-target',
      'body',
      'at',
      'worker_tool',
    )
    insertMessage.run(
      'message-sibling',
      'from_worker',
      'run-sibling',
      'run-sibling',
      'body',
      'at',
      'worker_tool',
    )

    const insertReview = database.query(
      'INSERT INTO review(record_id,number,recorded_at,project_record_id) VALUES (?,?,?,?)',
    )
    insertReview.run('review-target', 1, 'at', TARGET)
    insertReview.run('review-sibling', 2, 'at', SIBLING)
    const insertLens = database.query(
      `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,?,?,'[]','[]','[]','[]')`,
    )
    insertLens.run('lens-target', 'review-target', 'run-target', 'lens', 'agent')
    insertLens.run('lens-sibling', 'review-sibling', 'run-sibling', 'lens', 'agent')
    const insertFinding = database.query(
      `INSERT INTO review_finding
       (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction)
       VALUES (?,?,?,1,'major','file','evidence','fix')`,
    )
    insertFinding.run('finding-target', 'review-target', 'lens-target')
    insertFinding.run('finding-sibling', 'review-sibling', 'lens-sibling')

    const insertDoc = database.query(
      `INSERT INTO doc
       (record_id,scope,subject,slug,title,project_record_id,body,created_at,updated_at,audiences)
       VALUES (?,'project','subject',?,?,?,'body','at','at','["technical"]')`,
    )
    insertDoc.run('doc-target', 'target-doc', 'Target', TARGET)
    insertDoc.run('doc-sibling', 'sibling-doc', 'Sibling', SIBLING)
    const insertRevision = database.query(
      `INSERT INTO doc_revision
       (record_id,number,doc_record_id,scope,subject,slug,project_record_id,op,title,body,author,reason,at,audiences)
       VALUES (?,?,?,'project','subject',?,?,'set',?,'body','author','reason','at','["technical"]')`,
    )
    insertRevision.run('revision-target', 1, 'doc-target', 'target-doc', TARGET, 'Target')
    insertRevision.run('revision-sibling', 2, 'doc-sibling', 'sibling-doc', SIBLING, 'Sibling')

    database.exec(`
      INSERT INTO workflow(record_id,slug,created_at) VALUES ('workflow','workflow','at');
      INSERT INTO workflow_version
        (record_id,workflow_record_id,n,status,definition,author,reason,created_at)
        VALUES ('workflow-version','workflow',1,'production','{}','author','reason','at');
      INSERT INTO step_catalogue(record_id,slug,created_at) VALUES ('catalogue','catalogue','at');
      INSERT INTO step_catalogue_version
        (record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
        VALUES ('catalogue-version','catalogue',1,'production','{}','author','reason','at');
    `)
    const insertFlow = database.query(
      `INSERT INTO task_flow
       (record_id,task_record_id,project_record_id,state,created_at,updated_at)
       VALUES (?,?,?,'open','at','at')`,
    )
    insertFlow.run('flow-target', 'task-target', TARGET)
    insertFlow.run('flow-sibling', 'task-sibling', SIBLING)
    const insertCursor = database.query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at,
        task_record_id,task_flow_record_id)
       VALUES (?,?,?,?,?,'mode',?,'workflow-version','catalogue-version','{}',1,'at','at',?,?)`,
    )
    insertCursor.run(
      'cursor-target',
      1,
      'target',
      TARGET,
      'workflow',
      'instance-target',
      'task-target',
      'flow-target',
    )
    insertCursor.run(
      'cursor-sibling',
      2,
      'sibling',
      SIBLING,
      'workflow',
      'instance-sibling',
      'task-sibling',
      'flow-sibling',
    )
    database.query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?').run(
      'cursor-target',
      'flow-target',
    )
    database.query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?').run(
      'cursor-sibling',
      'flow-sibling',
    )

    const insertLanding = database.query(
      `INSERT INTO landing(record_id,project,project_record_id,branch,status,started_at,finished_at)
       VALUES (?,?,?,?,'landed','at','at')`,
    )
    insertLanding.run('landing-target', 'target', TARGET, 'DEV-1')
    insertLanding.run('landing-sibling', 'sibling', SIBLING, 'DEV-2')
    const insertBoard = database.query(
      `INSERT INTO board_message
       (record_id,number,kind,author_kind,author_run_record_id,author_project,author_project_record_id,
        audience,title,body,ack_required,created_at,expires_at)
       VALUES (?,?, 'notice','worker',?,?,?,'architects','title','body',0,'at','later')`,
    )
    insertBoard.run('board-target', 1, 'run-target', 'target', TARGET)
    insertBoard.run('board-sibling', 2, 'run-sibling', 'sibling', SIBLING)
    database
      .query('INSERT INTO main_stack_activity(project_record_id,last_ensured_at) VALUES (?,?)')
      .run(TARGET, 'at')
    database
      .query('INSERT INTO main_stack_activity(project_record_id,last_ensured_at) VALUES (?,?)')
      .run(SIBLING, 'at')
    const insertReach = database.query(
      `INSERT INTO board_reach_delivery
       (record_id,message_source,message_record_id,reader_session,reader_project,delivery_point,
        blocked_stop,audience,acknowledgement_required,posted_at,session_started_at,posting_timing,
        concern,recorded_at)
       VALUES (?,'local',?, 'session',?,'turn',0,'architects',0,'at','at','during','board','at')`,
    )
    insertReach.run('reach-target', 'board-target', 'target')
    insertReach.run('reach-sibling', 'board-sibling', 'sibling')

    const insertPortRef = database.query(
      `INSERT INTO port_ref(record_id,task_key,target_project_record_id,note,created_at,space_id)
       VALUES (?,?,?,?,?,?)`,
    )
    insertPortRef.run('port-target-local', 'DEV-1', TARGET, 'local', 'at', null)
    insertPortRef.run('port-target-hosted', 'DEV-2', TARGET, 'hosted', 'at', 'space')
    insertPortRef.run('port-sibling-local', 'DEV-3', SIBLING, 'sibling', 'at', null)
    const insertOutbox = database.query(
      `INSERT INTO outbox(kind,row_id,payload,created_at,synced_at,record_id)
       VALUES ('project',?,?, 'at',?,?)`,
    )
    insertOutbox.run('pending-target', JSON.stringify({ project_record_id: TARGET }), null, TARGET)
    insertOutbox.run('synced-target', JSON.stringify({ project_record_id: TARGET }), 'at', TARGET)
    insertOutbox.run('pending-sibling', JSON.stringify({ project_record_id: SIBLING }), null, SIBLING)

    const report = purgeLocalOrchestratorProject(database, TARGET, 'target', runsDirectory)
    expect(Object.fromEntries(report.map(({ table, count }) => [table, count]))).toMatchObject({
      run: 2,
      score: 1,
      question: 1,
      run_message: 1,
      review: 1,
      review_lens: 1,
      review_finding: 1,
      doc: 1,
      doc_revision: 1,
      workflow_cursor: 1,
      task_flow: 1,
      landing: 1,
      board_message: 1,
      board_reach_delivery: 1,
      main_stack_activity: 1,
      port_ref: 1,
      outbox: 1,
      run_artifact_directory: 1,
    })
    for (const [table, id] of [
      ['run', 'run-target'],
      ['score', 'score-target'],
      ['question', 'question-target'],
      ['run_message', 'message-target'],
      ['review', 'review-target'],
      ['review_lens', 'lens-target'],
      ['review_finding', 'finding-target'],
      ['doc', 'doc-target'],
      ['doc_revision', 'revision-target'],
      ['task_flow', 'flow-target'],
      ['workflow_cursor', 'cursor-target'],
      ['landing', 'landing-target'],
      ['board_message', 'board-target'],
      ['board_reach_delivery', 'reach-target'],
    ]) expect(database.query(`SELECT 1 FROM ${table} WHERE record_id=?`).get(id)).toBeNull()
    for (const [table, id] of [
      ['run', 'run-sibling'],
      ['score', 'score-sibling'],
      ['question', 'question-sibling'],
      ['run_message', 'message-sibling'],
      ['review', 'review-sibling'],
      ['review_lens', 'lens-sibling'],
      ['review_finding', 'finding-sibling'],
      ['doc', 'doc-sibling'],
      ['doc_revision', 'revision-sibling'],
      ['task_flow', 'flow-sibling'],
      ['workflow_cursor', 'cursor-sibling'],
      ['landing', 'landing-sibling'],
      ['board_message', 'board-sibling'],
      ['board_reach_delivery', 'reach-sibling'],
    ]) expect(database.query(`SELECT 1 FROM ${table} WHERE record_id=?`).get(id)).not.toBeNull()
    expect(database.query("SELECT 1 FROM port_ref WHERE record_id='port-target-hosted'").get()).not.toBeNull()
    expect(database.query("SELECT 1 FROM outbox WHERE row_id='synced-target'").get()).not.toBeNull()
    expect(existsSync(join(runsDirectory, 'run-target'))).toBeFalse()
    expect(existsSync(join(runsDirectory, 'run-sibling'))).toBeTrue()
    expect(database.query('DELETE FROM project WHERE record_id=?').run(TARGET).changes).toBe(1)
  } finally {
    database.close()
    rmSync(runsDirectory, { recursive: true, force: true })
  }
})
