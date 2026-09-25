import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

    expect(applyMigrations(database)).toEqual(['0048_user_canon_owner', '0049_operator_waiting'])
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
