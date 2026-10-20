import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  MIGRATIONS_FOLDER,
  migrationJournal,
} from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

function applyOneMigration(database: import('bun:sqlite').Database, tag: string): string[] {
  const journal = migrationJournal()
  const index = journal.findIndex((entry) => entry.tag === tag)
  const next = journal[index + 1]
  return next ? applyMigrationsBefore(database, next.tag) : applyMigrations(database)
}

test('board origin snapshot migration backfills an existing architect notice', () => {
  const database = migrationBoundaryTestDatabase('0074_board_origin_snapshot')
  try {
    database
      .query(
        `INSERT INTO presence(session_id,harness,role,machine,project,cwd,last_seen)
         VALUES ('author','claude-code','architect','test','posting-project','/tmp','2026-10-02')`,
      )
      .run()
    database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at)
         VALUES ('notice','architect','author','operator','Title','Body',0,'2026-10-03','2026-10-02')`,
      )
      .run()
    expect(applyOneMigration(database, '0074_board_origin_snapshot')).toEqual([
      '0074_board_origin_snapshot',
    ])
    expect(database.query('SELECT author_harness,author_project FROM board_message').get()).toEqual(
      { author_harness: 'claude-code', author_project: 'posting-project' },
    )
  } finally {
    database.close()
  }
})

test('board worker suggestion migration preserves messages, receipts, and tags', () => {
  const database = migrationBoundaryTestDatabase('0076_board_worker_suggestions')
  try {
    const message = database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at)
         VALUES ('notice','architect','author','operator','Title','Body',0,'2026-10-03','2026-10-02')
         RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO board_receipt
         (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
         VALUES (?,'operator',1,'2026-10-02',NULL)`,
      )
      .run(message.id)
    database
      .query(
        `INSERT INTO board_message_tag(message_id,kind,value,origin)
         VALUES (?,'topic','gate','sender')`,
      )
      .run(message.id)

    expect(applyOneMigration(database, '0076_board_worker_suggestions')).toEqual([
      '0076_board_worker_suggestions',
    ])
    expect(
      database
        .query('SELECT kind,author_kind,author_run_id,title FROM board_message WHERE id=?')
        .get(message.id),
    ).toEqual({
      kind: 'notice',
      author_kind: 'architect',
      author_run_id: null,
      title: 'Title',
    })
    expect(database.query('SELECT reader_session FROM board_receipt').get()).toEqual({
      reader_session: 'operator',
    })
    expect(database.query('SELECT kind,value,origin FROM board_message_tag').get()).toEqual({
      kind: 'topic',
      value: 'gate',
      origin: 'sender',
    })
  } finally {
    database.close()
  }
})

test('board thread migration preserves existing messages, receipts, and tags', () => {
  const database = migrationBoundaryTestDatabase('0077_board_threads')
  try {
    const message = database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at)
         VALUES ('notice','architect','author','operator','Title','Body',0,'2026-10-03','2026-10-02')
         RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO board_receipt
         (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
         VALUES (?,'operator',1,'2026-10-02',NULL)`,
      )
      .run(message.id)
    database
      .query(
        `INSERT INTO board_message_tag(message_id,kind,value,origin)
         VALUES (?,'topic','gate','sender')`,
      )
      .run(message.id)

    expect(applyOneMigration(database, '0077_board_threads')).toEqual(['0077_board_threads'])
    expect(
      database
        .query(
          `SELECT kind,title,thread_root_id,accepted_reply_id,note_id,note_pending_error,
                  note_filing_started_at
           FROM board_message`,
        )
        .get(),
    ).toEqual({
      kind: 'notice',
      title: 'Title',
      thread_root_id: null,
      accepted_reply_id: null,
      note_id: null,
      note_pending_error: null,
      note_filing_started_at: null,
    })
    expect(database.query('SELECT reader_session FROM board_receipt').get()).toEqual({
      reader_session: 'operator',
    })
    expect(database.query('SELECT kind,value,origin FROM board_message_tag').get()).toEqual({
      kind: 'topic',
      value: 'gate',
      origin: 'sender',
    })
  } finally {
    database.close()
  }
})

test('board claim migration preserves existing board rows and adds their nullable claim link', () => {
  const database = migrationBoundaryTestDatabase('0078_board_claims')
  try {
    database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at)
         VALUES ('notice','architect','author','operator','Title','Body',0,'2026-10-03','2026-10-02')`,
      )
      .run()
    expect(applyOneMigration(database, '0078_board_claims')).toEqual(['0078_board_claims'])
    expect(database.query('SELECT title,body,claim_id FROM board_message').get()).toEqual({
      title: 'Title',
      body: 'Body',
      claim_id: null,
    })
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='board_claim'")
        .get(),
    ).toEqual({ name: 'board_claim' })
  } finally {
    database.close()
  }
})

test('workflow question migration preserves run questions and backfills an awaiting cursor', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-workflow-questions-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0056_workflow_questions')
  const prior = journal.slice(0, migration)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = migrationBoundaryTestDatabase('0056_workflow_questions')
  try {
    database.exec('PRAGMA foreign_keys=ON')
    const run = database
      .query(
        `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('${newRecordId()}','2026-09-20','codex','implement','sha',1,'prompt','asking') RETURNING id`,
      )
      .get() as { id: number }
    const question = database
      .query(`INSERT INTO question (run_id,asked_at,question,asked_via) VALUES (?,?,?,'reply')`)
      .run(run.id, '2026-09-20', 'Run question?').lastInsertRowid
    database
      .query(
        `INSERT INTO question (id,run_id,asked_at,question) VALUES (99,?,'2026-09-20','deleted')`,
      )
      .run(run.id)
    database.query('DELETE FROM question WHERE id=99').run()
    const cursor = database
      .query(
        `INSERT INTO workflow_cursor
          (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('fixture','fixture-workflow','default','DEV-964','','owner',1,1,'{}',0,'build',
                 'awaiting-ruling','[]','Workflow question?',1,'2026-09-20','2026-09-21')
         RETURNING id`,
      )
      .get() as { id: number }

    database.exec(`
      CREATE TABLE question_mutation_audit (
        question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('rule','overturn','file')),
        actor_session TEXT,
        at TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX question_mutation_audit_question ON question_mutation_audit(question_id,at);
    `)
    database
      .query(
        `INSERT INTO question_delivery (question_id,run_id,mode,outcome,at,error)
         VALUES (?,?,'resume','delivered','2026-09-22',NULL)`,
      )
      .run(question, run.id)
    database
      .query('INSERT INTO run_carried_ruling (run_id,question_id) VALUES (?,?)')
      .run(run.id, question)
    database
      .query(
        `INSERT INTO question_mutation_audit
          (question_id,action,actor_session,at,reason)
         VALUES (?,'file','owner','2026-09-23','fixture')`,
      )
      .run(question)

    const source = readFileSync(join(MIGRATIONS_FOLDER, '0056_workflow_questions.sql'), 'utf8')
    writeFileSync(
      join(folder, '0056_workflow_questions.sql'),
      source.split('--> statement-breakpoint').slice(2).join('--> statement-breakpoint'),
    )
    copyFileSync(
      join(MIGRATIONS_FOLDER, '0057_review_finding_amendment.sql'),
      join(folder, '0057_review_finding_amendment.sql'),
    )
    copyFileSync(
      join(MIGRATIONS_FOLDER, '0058_question_record_id.sql'),
      join(folder, '0058_question_record_id.sql'),
    )
    copyFileSync(
      join(MIGRATIONS_FOLDER, '0059_question_revision.sql'),
      join(folder, '0059_question_revision.sql'),
    )
    copyFileSync(
      join(MIGRATIONS_FOLDER, '0060_mutation_audit_turn.sql'),
      join(folder, '0060_mutation_audit_turn.sql'),
    )
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: journal.slice(
          0,
          journal.findIndex((entry) => entry.tag === '0061_pull_request_triage_snapshot'),
        ),
      }),
    )
    expect(applyMigrations(database, folder)).toEqual([
      '0056_workflow_questions',
      '0057_review_finding_amendment',
      '0058_question_record_id',
      '0059_question_revision',
      '0060_mutation_audit_turn',
    ])
    expect(
      database
        .query(
          'SELECT run_id,workflow_cursor_id,workflow_key,question,asked_via FROM question ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        run_id: run.id,
        workflow_cursor_id: null,
        workflow_key: null,
        question: 'Run question?',
        asked_via: 'reply',
      },
      {
        run_id: null,
        workflow_cursor_id: cursor.id,
        workflow_key: 'DEV-964',
        question: 'Workflow question?',
        asked_via: 'workflow',
      },
    ])
    expect(database.query('SELECT * FROM question_delivery').all()).toEqual([
      {
        id: 1,
        question_id: Number(question),
        run_id: run.id,
        mode: 'resume',
        outcome: 'delivered',
        at: '2026-09-22',
        error: null,
      },
    ])
    expect(database.query('SELECT * FROM run_carried_ruling').all()).toEqual([
      { run_id: run.id, question_id: Number(question) },
    ])
    expect(database.query('SELECT * FROM question_mutation_audit').all()).toEqual([
      {
        question_id: Number(question),
        action: 'file',
        actor_session: 'owner',
        at: '2026-09-23',
        reason: 'fixture',
      },
    ])
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    const next = database
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question,asked_via)
         VALUES ('${newRecordId()}',?,'2026-09-24','Next?','reply') RETURNING id`,
      )
      .get(run.id) as { id: number }
    expect(next.id).toBeGreaterThan(99)
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
