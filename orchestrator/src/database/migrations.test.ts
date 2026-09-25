import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

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
         VALUES ('fixture','ship','default','DEV-964','','owner',1,1,'{}',0,'build',
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

    expect(applyMigrations(database)).toEqual([
      '0050_task_rulings',
      '0051_worker_gate',
      '0052_worker_gate_lifecycle',
      '0053_question_filed_ruling',
      '0054_file_ruling_audit',
      '0055_settings_doc_scope',
      '0056_workflow_questions',
      '0057_review_finding_amendment',
      '0058_question_record_id',
      '0059_question_revision',
      '0060_mutation_audit_turn',
      '0061_pull_request_triage_snapshot',
    ])
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
    expect(applyMigrations(database)).toEqual([
      '0039_agent_operator',
      '0040_workflow_cursor',
      '0041_readonly_clone_source',
      '0042_workflow_cursor_abandoned',
      '0043_lens_requires_execution',
      '0044_workflow_cursor_autonomy',
      '0045_question_delivery',
      '0046_unvoid_audit',
      '0047_project_task_identity',
      '0048_user_canon_owner',
      '0049_operator_waiting',
      '0050_task_rulings',
      '0051_worker_gate',
      '0052_worker_gate_lifecycle',
      '0053_question_filed_ruling',
      '0054_file_ruling_audit',
      '0055_settings_doc_scope',
      '0056_workflow_questions',
      '0057_review_finding_amendment',
      '0058_question_record_id',
      '0059_question_revision',
      '0060_mutation_audit_turn',
      '0061_pull_request_triage_snapshot',
    ])
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

    expect(applyMigrations(database)).toEqual([
      '0047_project_task_identity',
      '0048_user_canon_owner',
      '0049_operator_waiting',
      '0050_task_rulings',
      '0051_worker_gate',
      '0052_worker_gate_lifecycle',
      '0053_question_filed_ruling',
      '0054_file_ruling_audit',
      '0055_settings_doc_scope',
      '0056_workflow_questions',
      '0057_review_finding_amendment',
      '0058_question_record_id',
      '0059_question_revision',
      '0060_mutation_audit_turn',
      '0061_pull_request_triage_snapshot',
    ])
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

    expect(applyMigrations(database)).toEqual([
      '0048_user_canon_owner',
      '0049_operator_waiting',
      '0050_task_rulings',
      '0051_worker_gate',
      '0052_worker_gate_lifecycle',
      '0053_question_filed_ruling',
      '0054_file_ruling_audit',
      '0055_settings_doc_scope',
      '0056_workflow_questions',
      '0057_review_finding_amendment',
      '0058_question_record_id',
      '0059_question_revision',
      '0060_mutation_audit_turn',
      '0061_pull_request_triage_snapshot',
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
        (scope,subject,slug,title,body,delivery,created_at,updated_at,owner)
       VALUES (?,?,?,?,?,'inject','2026-01-02','2026-01-02','user-1')`,
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
