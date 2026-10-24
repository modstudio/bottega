import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0156_run_lifecycle_side_table_uuid_keys'
const ids = {
  run: '01990000-0000-7000-8000-000000001693',
  message: '01990000-0000-7000-8000-000000001694',
  checkpoint: '01990000-0000-7000-8000-000000001695',
  spawn: '01990000-0000-7000-8000-000000001696',
  note: '01990000-0000-7000-8000-000000001697',
  nextMessage: '01990000-0000-7000-8000-000000001698',
  nextNote: '01990000-0000-7000-8000-000000001699',
} as const

const tables = ['run_message', 'run_checkpoint', 'spawn', 'worker_note_request'] as const

test('K8b-2b makes run lifecycle side-table UUIDs primary keys without losing rows or indexes', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    database.exec(`
      INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('${ids.run}',1693,'run-at','codex','implement','sha',1,'prompt','running');
      INSERT INTO run_message(
        id,record_id,direction,root_run_record_id,run_record_id,sender_session,body,created_at,read_at,delivery,read_by
      ) VALUES (
        41,'${ids.message}','to_worker','${ids.run}','${ids.run}','kept-sender','kept-body','message-at',
        'read-at','architect_cli','kept-reader'
      );
      INSERT INTO run_checkpoint(id,record_id,run_record_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
      VALUES (51,'${ids.checkpoint}','${ids.run}',7,'kept-commit','kept-pointer',1,'checkpoint-at');
      INSERT INTO spawn(
        id,record_id,at,session_id,cwd,event,subagent_type,description,prompt_bytes,decision,why
      ) VALUES (
        61,'${ids.spawn}','spawn-at','kept-session','/kept/cwd','PreToolUse','general-purpose',
        'kept-description',123,'allowed','kept-why'
      );
      INSERT INTO worker_note_request(
        id,record_id,run_record_id,text,file,same_as,requested_at,claimed_at,finished_at,status,
        note_record_id,note_label,candidate_ids,candidate_labels,refusal_class,detail,project,project_record_id
      ) VALUES (
        71,'${ids.note}','${ids.run}','kept-text','kept.ts','${PLATFORM_SLUG}#7','requested-at','claimed-at',
        NULL,'requested',NULL,NULL,'["01990000-0000-7000-8000-000000000007"]','["${PLATFORM_SLUG}#7"]',
        NULL,'kept-detail','${PLATFORM_SLUG}',NULL
      );
    `)

    expect(applyMigrations(database)).toContain(MIGRATION)

    for (const table of tables) {
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
      expect(database.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 })
    }

    expect(database.query('SELECT * FROM run_message').get()).toEqual({
      record_id: ids.message,
      number: 41,
      direction: 'to_worker',
      root_run_record_id: ids.run,
      run_record_id: ids.run,
      sender_session: 'kept-sender',
      body: 'kept-body',
      created_at: 'message-at',
      read_at: 'read-at',
      delivery: 'architect_cli',
      read_by: 'kept-reader',
    })
    expect(database.query('SELECT * FROM run_checkpoint').get()).toEqual({
      record_id: ids.checkpoint,
      run_record_id: ids.run,
      checkpoint_no: 7,
      commit_sha: 'kept-commit',
      task_pointer: 'kept-pointer',
      final: 1,
      created_at: 'checkpoint-at',
    })
    expect(database.query('SELECT * FROM spawn').get()).toEqual({
      record_id: ids.spawn,
      at: 'spawn-at',
      session_id: 'kept-session',
      cwd: '/kept/cwd',
      event: 'PreToolUse',
      subagent_type: 'general-purpose',
      description: 'kept-description',
      prompt_bytes: 123,
      decision: 'allowed',
      why: 'kept-why',
    })
    expect(database.query('SELECT * FROM worker_note_request').get()).toEqual({
      record_id: ids.note,
      number: 71,
      run_record_id: ids.run,
      text: 'kept-text',
      file: 'kept.ts',
      same_as: `${PLATFORM_SLUG}#7`,
      requested_at: 'requested-at',
      claimed_at: 'claimed-at',
      finished_at: null,
      status: 'requested',
      note_record_id: null,
      note_label: null,
      candidate_ids: '["01990000-0000-7000-8000-000000000007"]',
      candidate_labels: `["${PLATFORM_SLUG}#7"]`,
      refusal_class: null,
      detail: 'kept-detail',
      project: PLATFORM_SLUG,
      project_record_id: null,
    })

    const indexNames = Object.fromEntries(
      tables.map((table) => [
        table,
        database
          .query<{ name: string }, []>(`SELECT name FROM pragma_index_list('${table}')`)
          .all()
          .map((row) => row.name),
      ]),
    )
    expect(indexNames.run_message).toEqual(
      expect.arrayContaining([
        'run_message_root',
        'run_message_run_record_id_idx',
        'run_message_unread',
      ]),
    )
    expect(indexNames.run_checkpoint).toHaveLength(2)
    expect(indexNames.spawn).toContain('spawn_at')
    expect(indexNames.worker_note_request).toEqual(
      expect.arrayContaining([
        'worker_note_request_pending',
        'worker_note_request_project_record_id',
      ]),
    )

    database
      .query(
        `INSERT INTO run_message(
           record_id,direction,root_run_record_id,run_record_id,body,created_at,delivery
         ) VALUES (?,'from_worker',?,?,'new-message','new-message-at','worker_tool')`,
      )
      .run(ids.nextMessage, ids.run, ids.run)
    database
      .query(
        `INSERT INTO worker_note_request(record_id,run_record_id,text,requested_at,status)
         VALUES (?,?,'new-note','new-note-at','requested')`,
      )
      .run(ids.nextNote, ids.run)
    expect(
      database.query('SELECT number FROM run_message WHERE record_id=?').get(ids.nextMessage),
    ).toEqual({
      number: 42,
    })
    expect(
      database.query('SELECT number FROM worker_note_request WHERE record_id=?').get(ids.nextNote),
    ).toEqual({ number: 72 })
    database
      .query(
        "DELETE FROM entity_number_counter WHERE entity IN ('run_message','worker_note_request')",
      )
      .run()
    expect(() =>
      database
        .query(
          `INSERT INTO run_message(
             record_id,direction,root_run_record_id,run_record_id,body,created_at,delivery
           ) VALUES ('01990000-0000-7000-8000-000000001700','from_worker',?,?,'refused','at','worker_tool')`,
        )
        .run(ids.run, ids.run),
    ).toThrow('run message number counter is missing')
    expect(() =>
      database
        .query(
          `INSERT INTO worker_note_request(record_id,run_record_id,text,requested_at,status)
           VALUES ('01990000-0000-7000-8000-000000001701',?,'refused','at','requested')`,
        )
        .run(ids.run),
    ).toThrow('worker note request number counter is missing')
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})
