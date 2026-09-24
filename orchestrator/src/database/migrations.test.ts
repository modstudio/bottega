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
