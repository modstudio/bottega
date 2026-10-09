import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import {
  applyMigrations,
  expectedSchemaHash,
  MIGRATIONS_FOLDER,
  migrationJournal,
} from './migrations.ts'

function pendingMigrationsFrom(tag: string): string[] {
  const journal = migrationJournal()
  return journal.slice(journal.findIndex((entry) => entry.tag === tag)).map((entry) => entry.tag)
}

test('embedded migrations produce the disk journal and schema hash', () => {
  const diskJournal = migrationJournal()
  const diskHash = expectedSchemaHash()
  const assets: Record<string, string> = {
    'orchestrator/migrations/meta/_journal.json': readFileSync(
      join(MIGRATIONS_FOLDER, 'meta', '_journal.json'),
      'utf8',
    ),
  }
  for (const entry of diskJournal) {
    assets[`orchestrator/migrations/${entry.tag}.sql`] = readFileSync(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      'utf8',
    )
  }
  registerEmbeddedAssets({
    assets,
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-09-18T12:34:56.000Z',
      commit: 'abcdef1234567890',
    },
  })
  try {
    expect(migrationJournal()).toEqual(diskJournal)
    expect(expectedSchemaHash()).toBe(diskHash)
  } finally {
    registerEmbeddedAssets(null)
  }
})

test('a fresh database seeds discoverable agents without machine probe claims', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    const rows = database
      .query(
        'SELECT name, caps, billing, operated_by, probed_at, probe_result FROM agent ORDER BY name',
      )
      .all() as {
      name: string
      caps: string
      billing: string
      operated_by: string
      probed_at: string | null
      probe_result: string | null
    }[]

    expect(rows.map((row) => row.name)).toEqual(['agy', 'codex', 'grok', 'qwen-local'])
    expect(rows.every((row) => row.probed_at === null && row.probe_result === null)).toBe(true)
    expect(rows.every((row) => Object.hasOwn(JSON.parse(row.caps), 'readsRepo'))).toBe(true)
    expect(rows.map(({ name, billing, operated_by }) => ({ name, billing, operated_by }))).toEqual([
      { name: 'agy', billing: 'free', operated_by: 'vendor' },
      { name: 'codex', billing: 'subscription', operated_by: 'vendor' },
      { name: 'grok', billing: 'subscription', operated_by: 'vendor' },
      { name: 'qwen-local', billing: 'none', operated_by: 'self' },
    ])
    expect(
      database
        .query(
          `SELECT name,"notnull" AS required FROM pragma_table_info('release_ledger') WHERE name='actor'`,
        )
        .get(),
    ).toEqual({ name: 'actor', required: 1 })
  } finally {
    database.close()
  }
})

test('document identity migration backfills UUIDs and makes record_id required and fully unique', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-doc-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex(
    (entry) => entry.tag === '0090_doc_record_identity_and_subject',
  )
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    database
      .query(
        `INSERT INTO doc
         (scope,subject,slug,title,body,delivery,created_at,updated_at,record_id)
         VALUES ('global',NULL,'identity','Identity','Body','demand','2026-10-08','2026-10-08',NULL)`,
      )
      .run()
    expect(applyMigrations(database)).toEqual(
      pendingMigrationsFrom('0090_doc_record_identity_and_subject'),
    )
    const identity = database.query<{ record_id: string }, []>('SELECT record_id FROM doc').get()!
    expect(identity.record_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(
      database
        .query<{ notnull: number }, []>(
          `SELECT "notnull" FROM pragma_table_info('doc') WHERE name='record_id'`,
        )
        .get()?.notnull,
    ).toBe(1)
    expect(
      database
        .query<{ unique: number; partial: number }, []>(
          `SELECT "unique",partial FROM pragma_index_list('doc') WHERE name='doc_record_id'`,
        )
        .get(),
    ).toEqual({ unique: 1, partial: 0 })
    expect(() =>
      database
        .query(
          `INSERT INTO doc
           (scope,subject,slug,title,body,delivery,created_at,updated_at,record_id)
           VALUES ('global',NULL,'missing','Missing','Body','demand','2026-10-08','2026-10-08',NULL)`,
        )
        .run(),
    ).toThrow()
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('note UUID reference migration preserves rows and turns old integers into display labels', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-note-uuid-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0091_note_uuid_references')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    const run = database
      .query(
        `INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('2026-10-09','codex','implement','sha',1,'prompt','ok') RETURNING id`,
      )
      .get() as { id: number }
    database
      .query(
        `INSERT INTO worker_note_request
         (run_id,text,requested_at,finished_at,status,note_id,candidate_ids)
         VALUES (?,'finding','2026-10-09','2026-10-09','filed',71,'[8,13]')`,
      )
      .run(run.id)
    database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,note_id)
         VALUES ('question','architect','author','operator','Title','Body',0,'2026-10-10','2026-10-09',72)`,
      )
      .run()

    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0091_note_uuid_references'))
    expect(
      database
        .query(
          `SELECT note_record_id,note_label,candidate_ids,candidate_labels
           FROM worker_note_request`,
        )
        .get(),
    ).toEqual({
      note_record_id: null,
      note_label: '71',
      candidate_ids: '[]',
      candidate_labels: '["8","13"]',
    })
    expect(
      database.query('SELECT note_record_id,note_label FROM board_message').get(),
    ).toEqual({ note_record_id: null, note_label: '72' })
    expect(
      database
        .query(
          `SELECT name FROM pragma_table_info('worker_note_request')
           WHERE name='note_id'`,
        )
        .get(),
    ).toBeNull()
    expect(
      database
        .query(`SELECT name FROM pragma_table_info('board_message') WHERE name='note_id'`)
        .get(),
    ).toBeNull()
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('board origin snapshot migration backfills an existing architect notice', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-board-origin-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const snapshotMigration = journal.findIndex((entry) => entry.tag === '0074_board_origin_snapshot')
  const prior = journal.slice(0, snapshotMigration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
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
    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0074_board_origin_snapshot'))
    expect(database.query('SELECT author_harness,author_project FROM board_message').get()).toEqual(
      { author_harness: 'claude-code', author_project: 'posting-project' },
    )
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('board worker suggestion migration preserves messages, receipts, and tags', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-board-worker-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0076_board_worker_suggestions')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
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

    expect(applyMigrations(database)).toEqual(
      pendingMigrationsFrom('0076_board_worker_suggestions'),
    )
    expect(
      database
        .query('SELECT kind,author_kind,author_run_id,title FROM board_message WHERE id=?')
        .get(message.id),
    ).toEqual({ kind: 'notice', author_kind: 'architect', author_run_id: null, title: 'Title' })
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
    rmSync(folder, { recursive: true, force: true })
  }
})

test('board thread migration preserves existing messages, receipts, and tags', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-board-threads-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0077_board_threads')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
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

    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0077_board_threads'))
    expect(
      database
        .query(
          `SELECT kind,title,thread_root_id,accepted_reply_id,note_record_id,note_label,
                  note_filing_started_at
           FROM board_message`,
        )
        .get(),
    ).toEqual({
      kind: 'notice',
      title: 'Title',
      thread_root_id: null,
      accepted_reply_id: null,
      note_record_id: null,
      note_label: null,
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
    rmSync(folder, { recursive: true, force: true })
  }
})

test('board claim migration preserves existing board rows and adds their nullable claim link', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-board-claims-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0078_board_claims')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at)
         VALUES ('notice','architect','author','operator','Title','Body',0,'2026-10-03','2026-10-02')`,
      )
      .run()
    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0078_board_claims'))
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
    rmSync(folder, { recursive: true, force: true })
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
  const database = new Database(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON')
    applyMigrations(database, folder)
    const run = database
      .query(
        `INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('2026-09-20','codex','implement','sha',1,'prompt','asking') RETURNING id`,
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
        `INSERT INTO question (run_id,asked_at,question,asked_via)
         VALUES (?,'2026-09-24','Next?','reply') RETURNING id`,
      )
      .get(run.id) as { id: number }
    expect(next.id).toBeGreaterThan(99)
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('task rulings migration applies cleanly and preserves mutation audit rows', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-task-rulings-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const taskRulingsMigration = journal.findIndex((entry) => entry.tag === '0050_task_rulings')
  const prior = journal.slice(0, taskRulingsMigration)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    const run = database
      .query(
        `INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('2026-09-20','codex','implement','sha',1,'prompt','ok') RETURNING id`,
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
    expect(() =>
      database
        .query(
          `INSERT INTO run_mutation_audit (run_id,root_id,action,at)
           VALUES (?,?,'overturn','2026-09-22')`,
        )
        .run(run.id, run.id),
    ).not.toThrow()
    expect(() =>
      database
        .query(
          `INSERT INTO run_mutation_audit (run_id,root_id,action,at)
           VALUES (?,?,'file','2026-09-23')`,
        )
        .run(run.id, run.id),
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
    ).toHaveLength(3)
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='run_carried_ruling'")
        .get(),
    ).toEqual({ name: 'run_carried_ruling' })
    expect(
      database
        .query("SELECT name FROM pragma_table_info('run_mutation_audit') WHERE name='turn_id'")
        .get(),
    ).toEqual({ name: 'turn_id' })
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('agent operator migration preserves cost facts and the routing free set', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-agent-operator-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const operatorMigration = journal.findIndex((entry) => entry.tag === '0039_agent_operator')
  const prior = journal.slice(0, operatorMigration)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
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
    rmSync(folder, { recursive: true, force: true })
  }
})

test('project task identity migration backfills ledger project relationships', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-project-task-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const identityMigration = journal.findIndex((entry) => entry.tag === '0047_project_task_identity')
  const prior = journal.slice(0, identityMigration)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
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

    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0047_project_task_identity'))
    expect(database.query('SELECT * FROM port_ref_source').get()).toMatchObject({
      task_key: 'SHARED-1',
      target_project_id: project.id,
      source_project_id: source.id,
    })
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('user canon owner migration preserves docs and enforces owner addresses', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-user-canon-owner-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const ownerMigration = journal.findIndex((entry) => entry.tag === '0048_user_canon_owner')
  const prior = journal.slice(0, ownerMigration)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
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

    expect(applyMigrations(database)).toEqual(pendingMigrationsFrom('0048_user_canon_owner'))
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
    rmSync(folder, { recursive: true, force: true })
  }
})
