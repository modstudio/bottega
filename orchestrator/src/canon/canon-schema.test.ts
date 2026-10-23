import { Database } from 'bun:sqlite'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'

// Six of these tests spawn the orch CLI and apply the whole migration journal
// to scratch stores; each grew past bun's 5 s default as the journal gained
// entries (0001, 0002) and the inventory widened, and they timed out in a
// landing gate on 2026-09-07. The bound is sized to that work, like the CLI
// leg's; it is not a hidden widening.
setDefaultTimeout(30_000)

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { dir } from '../../test/fixtures/store.ts'
import {
  closeDatabaseForFixture,
  db,
  enableSchemaReload,
  writeTransaction,
} from '../database/db.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  CONNECTION_SCHEMA_INVARIANT,
  MIGRATIONS_FOLDER,
  migrationJournal,
  migrationRefusal,
  readUserVersion,
  SCHEMA_LOCK_TABLE,
  schemaVersionLabel,
  splitMigrationSource,
  stripSqlComments,
} from '../database/migrations.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { upsertProject } from '../project/projects.ts'
import { recordedCoordinatorCause } from '../run/run-coordinator-log.ts'
import { enableRunSchemaReload } from '../run/run-schema-reload-cause.ts'
import {
  BRACE_EXPANSION_LIMIT,
  braceExpansionUpperBound,
  checkDoc,
  compilePack,
  findingsForPack,
  allNumericLiterals as inspectNumericLiterals,
  numericLiteralReport,
  repoRootForDoc,
} from './canon.ts'

const journalLength = () => migrationJournal().length
const journalVersionAfter = (tag: string): number => {
  const entry = migrationJournal().find((candidate) => candidate.tag === tag)
  if (!entry) throw new Error(`missing migration fixture ${tag}`)
  return entry.idx + 1
}

const fresh = () => migratedTestDatabase()

describe('schema coexistence', () => {
  test('the migrator stamps user_version to the journal length even when nothing is pending', () => {
    const folder = mkdtempSync(join(tmpdir(), 'orch-user-version-stamp-'))
    mkdirSync(join(folder, 'meta'))
    writeFileSync(join(folder, '0000_base.sql'), 'CREATE TABLE fixture (id INTEGER PRIMARY KEY);\n')
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1,
            tag: '0000_base',
            breakpoints: true,
          },
        ],
      }),
    )
    const d = new Database(':memory:')
    expect(applyMigrations(d, folder)).toEqual(['0000_base'])
    d.exec('PRAGMA user_version=0')
    expect(applyMigrations(d, folder)).toEqual([])
    expect(readUserVersion(d)).toBe(1)
    expect(schemaVersionLabel(d)).toBe('1')
    d.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('a complete journal has the current schema and a 0009 store resumes with 0010', () => {
    const minted = fresh()
    expect(journalLength()).toBe(migrationJournal().length)
    expect(readUserVersion(minted)).toBe(journalLength())
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='confinement'").get(),
    ).toEqual({ name: 'confinement' })
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='mcp_probe'").get(),
    ).toEqual({ name: 'mcp_probe' })
    expect(
      minted.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contention'").get(),
    ).toBeDefined()
    expect(
      minted.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_flake'").get(),
    ).toBeDefined()
    expect(
      minted.query("SELECT name FROM pragma_table_info('test_flake') WHERE name='signal'").get(),
    ).toEqual({ name: 'signal' })
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='last_event_at'").get(),
    ).toEqual({ name: 'last_event_at' })
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='minted_branch'").get(),
    ).toEqual({ name: 'minted_branch' })
    minted.close()

    const dir = mkdtempSync(join(tmpdir(), 'orch-through-0009-'))
    mkdirSync(join(dir, 'meta'))
    const through0009 = migrationJournal().slice(0, 10)
    for (const entry of through0009) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: through0009,
      }),
    )
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(d, dir)).toEqual(through0009.map((entry) => entry.tag))
    expect(readUserVersion(d)).toBe(through0009.length)
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='last_event_at'").get(),
    ).toEqual({ name: 'last_event_at' })
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='minted_branch'").get(),
    ).toBeNull()
    const next = migrationJournal()[10]!
    const afterNext = migrationJournal()[11]!
    expect(applyMigrationsBefore(d, afterNext.tag)).toEqual([next.tag])
    expect(readUserVersion(d)).toBe(11)
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='last_event_at'").get(),
    ).toEqual({ name: 'last_event_at' })
    expect(
      d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='landing'").get(),
    ).toBeDefined()
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a connection opened before a migration refuses its next write', () => {
    db()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    expect(() =>
      writeTransaction(() => {
        db().query('UPDATE project SET name = name WHERE 0').run()
      }),
    ).toThrow(`invariant: ${CONNECTION_SCHEMA_INVARIANT}`)
    try {
      writeTransaction(() => {
        db().query('UPDATE project SET name = name WHERE 0').run()
      })
    } catch (error) {
      expect(String(error)).toContain(
        `cleared by: restart this process after ${PLATFORM_SLUG} machine migrate`,
      )
    }
  })

  test('review project_record_id backfill requires aliased lens repos to collapse to one project', () => {
    const d = fresh()
    d.query(
      `INSERT INTO project (record_id,name,path,canon,settings) VALUES (?, ?, '/p', 1, '{}')`,
    ).run(newRecordId(), PLATFORM_SLUG)
    d.query(
      `INSERT INTO project (record_id,name,path,canon,settings) VALUES (?, 'starship', '/s', 1, '{}')`,
    ).run(newRecordId())
    d.query(
      `INSERT INTO project (record_id,name,path,canon,settings) VALUES (?, 'alephbeis', '/a', 1, '{}')`,
    ).run(newRecordId())
    const platformId = (
      d.query('SELECT record_id AS id FROM project WHERE name=?').get(PLATFORM_SLUG) as {
        id: string
      }
    ).id
    const starship = (
      d.query("SELECT record_id AS id FROM project WHERE name='starship'").get() as { id: string }
    ).id
    const alephbeis = (
      d.query("SELECT record_id AS id FROM project WHERE name='alephbeis'").get() as { id: string }
    ).id
    const insertRun = (repo: string, projectId: string) =>
      (
        d
          .query(
            `INSERT INTO run (record_id,number,started_at, agent, job, repo, project_record_id, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'t', 'a', 'review-lens', ?, ?, 'sha', 1, 'h', 'ok') RETURNING record_id AS id`,
          )
          .get(repo, projectId) as { id: string }
      ).id
    const mixed = (
      d
        .query(
          `INSERT INTO review (record_id,number,recorded_at) VALUES ('${newRecordId()}',8001,'t') RETURNING record_id`,
        )
        .get() as { record_id: string }
    ).record_id
    const aliased = (
      d
        .query(
          `INSERT INTO review (record_id,number,recorded_at) VALUES ('${newRecordId()}',8002,'t') RETURNING record_id`,
        )
        .get() as { record_id: string }
    ).record_id
    const mixedA = insertRun('starship', starship)
    const mixedB = insertRun('alephbeis', alephbeis)
    const aliasA = insertRun(PLATFORM_SLUG, platformId)
    const aliasB = insertRun('devbox', platformId)
    const lens = (reviewId: string, runId: string, name: string) => {
      d.query(
        `INSERT INTO review_lens (record_id, review_record_id, run_record_id, lens, agent, standards_read, files_covered, commands_run, could_not_verify)
         VALUES ('${newRecordId()}', ?, ?, ?, 'codex', '[]', '[]', '[]', '[]')`,
      ).run(reviewId, runId, name)
    }
    lens(mixed, mixedA, 'a')
    lens(mixed, mixedB, 'b')
    lens(aliased, aliasA, 'a')
    lens(aliased, aliasB, 'b')
    expect(applyMigrations(d)).toEqual([])
    expect(d.query('SELECT project_record_id FROM review WHERE record_id=?').get(mixed)).toEqual({
      project_record_id: null,
    })
    expect(d.query('SELECT project_record_id FROM review WHERE record_id=?').get(aliased)).toEqual({
      project_record_id: platformId,
    })
    d.close()
  })

  test('a pre-migration row is repaired by the next migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-backfill-repair-'))
    mkdirSync(join(dir, 'meta'))
    const through0005 = migrationJournal().slice(0, 6)
    for (const entry of through0005) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: through0005,
      }),
    )
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    applyMigrations(d, dir)
    d.query(
      `INSERT INTO project (name, path, canon, settings) VALUES ('widget', '/tmp/widget', 1, '{}')`,
    ).run()
    d.query(
      `INSERT INTO run (started_at, agent, job, repo, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('t', 'a', 'implement', 'widget', 'sha', 1, 'h', 'ok')`,
    ).run()
    expect(d.query('SELECT project_id FROM run').get()).toEqual({
      project_id: null,
    })
    const before = applyMigrationsBefore(d, '0115_project_identity_contract')
    d.query('UPDATE project SET record_id=? WHERE name=?').run(newRecordId(), 'widget')
    const after = applyMigrations(d)
    expect([...before, ...after]).toEqual(
      migrationJournal()
        .slice(6)
        .map((entry) => entry.tag),
    )
    const row = d
      .query(
        'SELECT project_record_id, (SELECT record_id AS id FROM project WHERE name=?) expected FROM run',
      )
      .get('widget') as { project_record_id: number; expected: number }
    expect(row.project_record_id).toBe(row.expected)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('two concurrent migrates serialize on the schema lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-concurrent-migrate-'))
    const path = join(dir, 'store.db')
    const run = () => {
      const d = new Database(path)
      const versions = applyMigrations(d)
      d.close()
      return versions
    }
    const [first, second] = await Promise.all([
      Promise.resolve().then(run),
      Promise.resolve().then(run),
    ])
    expect([...first, ...second].sort()).toEqual(
      migrationJournal()
        .map((entry) => entry.tag)
        .sort(),
    )
    const seen = new Database(path)
    expect(
      seen
        .query(`SELECT version FROM ${'orch_migrations'} GROUP BY version HAVING COUNT(*) > 1`)
        .all(),
    ).toEqual([])
    expect(readUserVersion(seen)).toBe(journalLength())
    expect(
      seen.query(`SELECT 1 FROM sqlite_master WHERE name=?`).get(SCHEMA_LOCK_TABLE),
    ).toBeDefined()
    seen.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the ahead ceiling keys on applied count, not the last entry when', () => {
    const d = fresh()
    const existing = d
      .query('SELECT hash, created_at, version FROM orch_migrations LIMIT 1')
      .get() as { hash: string; created_at: number; version: string }
    d.query('INSERT INTO orch_migrations (hash, created_at, version) VALUES (?, ?, ?)').run(
      existing.hash,
      existing.created_at,
      existing.version,
    )
    expect(migrationRefusal(d)).toContain('refusing to open a store ahead')
    d.close()
  })

  test('backfill blocks are stripped from the hashed DDL and re-run every migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-backfill-block-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(
      join(dir, '0000_base.sql'),
      'CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER);\n',
    )
    writeFileSync(
      join(dir, '0001_fill.sql'),
      '-- note\n-- BACKFILL\nINSERT INTO item (n) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM item WHERE n=1);\n-- /BACKFILL\n',
    )
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1,
            tag: '0000_base',
            breakpoints: true,
          },
          {
            idx: 1,
            version: '6',
            when: 2,
            tag: '0001_fill',
            breakpoints: true,
          },
        ],
      }),
    )
    expect(splitMigrationSource(readFileSync(join(dir, '0001_fill.sql'), 'utf8')).ddl).toBe(
      '-- note\n',
    )
    const d = new Database(':memory:')
    expect(applyMigrations(d, dir)).toEqual(['0000_base', '0001_fill'])
    expect(d.query('SELECT COUNT(*) n FROM item').get()).toEqual({ n: 1 })
    d.exec('DELETE FROM item')
    expect(applyMigrations(d, dir)).toEqual([])
    expect(d.query('SELECT COUNT(*) n FROM item').get()).toEqual({ n: 1 })
    expect(readUserVersion(d)).toBe(2)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('writeTransaction after an additive migration writes on the still-open handle', () => {
    const next = journalVersionAfter('0145_agent_trains_on_inputs')
    const prior = next - 1
    closeDatabaseForFixture()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${prior}`)
    enableSchemaReload(() => {})
    const held = db()
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()
    writeTransaction(() => {
      db()
        .query(
          "INSERT INTO project (record_id,name,path,canon,settings) VALUES ('01990000-0000-7000-8000-000000001201','held-reload', '/held', 1, '{}')",
        )
        .run()
    }, held)
    expect(held.query('SELECT 1').get()).toEqual({ '1': 1 })
    expect(db()).toBe(held)
    expect(db().query("SELECT name FROM project WHERE name='held-reload'").get()).toEqual({
      name: 'held-reload',
    })
  })

  test('schema reload waits until an open write transaction completes', () => {
    const seen: Array<[number | null, number]> = []
    const next = journalVersionAfter('0145_agent_trains_on_inputs')
    const prior = next - 1
    closeDatabaseForFixture()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${prior}`)
    const held = db()
    enableSchemaReload((from, to) => seen.push([from, to]))
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()

    held
      .transaction(() => {
        held
          .query(
            "INSERT INTO project (record_id,name,path,canon,settings) VALUES ('01990000-0000-7000-8000-000000001202','before-reload', '/before', 1, '{}')",
          )
          .run()
        db()
          .query(
            "INSERT INTO project (record_id,name,path,canon,settings) VALUES ('01990000-0000-7000-8000-000000001203','after-reload', '/after', 1, '{}')",
          )
          .run()
      })
      .immediate()

    expect(seen).toEqual([])
    expect(
      held.query("SELECT name FROM project WHERE name LIKE '%-reload' ORDER BY name").all(),
    ).toEqual([{ name: 'after-reload' }, { name: 'before-reload' }])
    expect(db()).toBe(held)
    expect(seen).toEqual([[prior, next]])
    expect(held.query('SELECT 1').get()).toEqual({ '1': 1 })
  })

  test('reload mode names an unmarked migration instead of closing the handle', () => {
    const next = journalVersionAfter('0131_lens_port_uuid_key')
    const prior = next - 1
    closeDatabaseForFixture()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${prior}`)
    const held = db()
    enableSchemaReload(() => {})
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()

    expect(() => db()).toThrow(
      `store migrated from version ${prior} to ${next} past this process's version; restart this process, and re-dispatch any run it was coordinating`,
    )
    expect(held.query('SELECT 1').get()).toEqual({ '1': 1 })
  })

  test('run reload records the named refusal when an unmarked migration advances', () => {
    const next = journalVersionAfter('0131_lens_port_uuid_key')
    const prior = next - 1
    const runId = newRecordId()
    closeDatabaseForFixture()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${prior}`)
    db()
    enableRunSchemaReload(runId)
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()

    const reason =
      `store migrated from version ${prior} to ${next} past this process's version; ` +
      `restart this process, and re-dispatch any run it was coordinating`
    expect(() => db()).toThrow(reason)
    expect(recordedCoordinatorCause(runId)).toBe(reason)
  })
})

describe('stripSqlComments feeds exec text that keeps quoted comment markers', () => {
  test('a quoted -- or /* survives, real comments go, and a trailing comment cannot swallow a failure', () => {
    expect(stripSqlComments("INSERT INTO t (v) VALUES ('a -- b'); -- seed\n")).toBe(
      "INSERT INTO t (v) VALUES ('a -- b'); \n",
    )
    expect(stripSqlComments("SELECT '/* not a comment */' /* real */ FROM t")).toBe(
      "SELECT '/* not a comment */'  FROM t",
    )
    expect(stripSqlComments("SELECT 'it''s -- fine' FROM t")).toBe("SELECT 'it''s -- fine' FROM t")
    expect(stripSqlComments('INSERT INTO boom (id) VALUES (1); -- again').trim()).toBe(
      'INSERT INTO boom (id) VALUES (1);',
    )
  })
})

describe('scoped operator docs', () => {
  test('project-subject document roots use the registered project and preserve canon selection', () => {
    upsertProject({
      recordId: newRecordId(),
      name: 'doc-root-project',
      path: '/work/doc-root-project',
      stack: null,
      canon: true,
      settings: {},
    })
    for (const scope of ['project', 'resume', 'settings', 'canon'] as const) {
      expect(repoRootForDoc({ scope, subject: 'doc-root-project' }), scope).toBe(
        '/work/doc-root-project',
      )
    }
    expect(repoRootForDoc({ scope: 'canon', subject: 'doc-root-project' }, '/selected')).toBe(
      '/selected',
    )
    expect(repoRootForDoc({ scope: 'resume', subject: 'unregistered' })).toBeNull()
    expect(repoRootForDoc({ scope: 'project', subject: null })).toBeNull()
    const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
    for (const [scope, subject] of [
      ['canon', null],
      ['resume', null],
      ['settings', null],
      ['machine', null],
      ['global', null],
      ['agent', 'codex'],
      ['job', 'understand'],
      ['stack', 'typescript'],
    ] as const) {
      expect(repoRootForDoc({ scope, subject }), scope).toBe(root)
    }
  })

  test('document path references expand braces while preserving literal behavior', () => {
    const options = {
      repoRoot: '/fixture',
      trackedFiles: new Set(['scripts/a-reads.php', 'scripts/plain.php']),
    }
    expect(checkDoc('`scripts/a-{reads,writes}.php`', options)).toEqual([
      {
        kind: 'path',
        token: 'scripts/a-{reads,writes}.php',
        line: 1,
        message: 'line 1: `scripts/a-writes.php` is not tracked in /fixture',
      },
    ])
    expect(
      checkDoc('`scripts/a-{reads,writes}.php`', {
        repoRoot: '/fixture',
        trackedFiles: new Set(['scripts/a-reads.php', 'scripts/a-writes.php']),
      }),
    ).toEqual([])
    expect(checkDoc('`scripts/missing.php`', options)).toEqual([
      {
        kind: 'path',
        token: 'scripts/missing.php',
        line: 1,
        message: 'line 1: `scripts/missing.php` is not tracked in /fixture',
      },
    ])
  })

  test('a tracked document path with a symbol suffix is accepted', () => {
    expect(
      checkDoc('`shared/git.ts:borrowedCheckoutFromAlternates`', {
        repoRoot: '/fixture',
        trackedFiles: new Set(['shared/git.ts']),
      }),
    ).toEqual([])
  })

  test('a dispatch citation naming an unknown job is flagged', () => {
    const options = { repoRoot: '/fixture', trackedFiles: new Set<string>() }
    expect(
      checkDoc(`\`${PLATFORM_SLUG} run start nosuchjob\``, options).map((finding) => finding.kind),
    ).toContain('job')
    expect(
      checkDoc(`\`${PLATFORM_SLUG} run start implement\``, options).map((finding) => finding.kind),
    ).not.toContain('job')
  })

  test('document path brace expansion is bounded before expansion', () => {
    const token = `scripts/${'{a,b}'.repeat(16)}.php`
    expect(braceExpansionUpperBound(token)).toBe(65_536)
    expect(braceExpansionUpperBound(token)).toBeGreaterThan(BRACE_EXPANSION_LIMIT)
    expect(
      checkDoc(`\`${token}\``, {
        repoRoot: '/fixture',
        trackedFiles: new Set(),
      }),
    ).toHaveLength(1)
    expect(braceExpansionUpperBound('scripts/a-{reads,writes}.php')).toBe(2)
  })

  test('numeric literal report classifies per clause and excludes non-prose spans', () => {
    const cases: { text: string; expected: [string, string][] }[] = [
      {
        text: 'The suite currently has 6,676 tests.',
        expected: [['6,676', 'RESTATED']],
      },
      {
        text: 'The service listens on port 5432.',
        expected: [['5432', 'RESTATED']],
      },
      { text: 'Bun 1.3.14 is installed.', expected: [['1.3.14', 'RESTATED']] },
      { text: 'Qwen3.6 is installed.', expected: [['Qwen3.6', 'RESTATED']] },
      { text: 'The default is 5.', expected: [['5', 'OWNED']] },
      {
        text: 'This policy defines and enforces the threshold of 15.',
        expected: [['15', 'OWNED']],
      },
      { text: 'A product admits at most 1 tag.', expected: [['1', 'OWNED']] },
      {
        text: 'A change under 10% is reported as flat.',
        expected: [['10%', 'OWNED']],
      },
      {
        text: 'The gate asserts 170 characters.',
        expected: [['170', 'CHECKED']],
      },
      { text: 'The check refuses 51 lines.', expected: [['51', 'CHECKED']] },
      {
        text: 'This check caps output at 20 bytes.',
        expected: [['20', 'CHECKED']],
      },
      {
        text: 'Run 1565 measured 36,058 rows.',
        expected: [
          ['1565', 'EVIDENCE'],
          ['36,058', 'EVIDENCE'],
        ],
      },
      { text: 'We observed 42 rows.', expected: [['42', 'EVIDENCE']] },
      { text: 'The sample measured 80 bytes.', expected: [['80', 'EVIDENCE']] },
      {
        text: 'The incident had 22 files.',
        expected: [['22', 'UNCLASSIFIED']],
      },
      { text: 'Build 4 succeeded.', expected: [['4', 'UNCLASSIFIED']] },
      { text: 'Option 7 is preferred.', expected: [['7', 'UNCLASSIFIED']] },
      {
        text: 'Version 2 was used during the incident.',
        expected: [['2', 'UNCLASSIFIED']],
      },
      {
        text: 'Do not trust the claim that the suite has 900 tests.',
        expected: [['900', 'UNCLASSIFIED']],
      },
      {
        text: 'Its 22 files are recoverable from the old commit.',
        expected: [['22', 'UNCLASSIFIED']],
      },
      {
        text: 'Run 279 is the case: 409 seconds, 57 bytes back.',
        expected: [
          ['279', 'EVIDENCE'],
          ['409', 'EVIDENCE'],
          ['57', 'UNCLASSIFIED'],
        ],
      },
      {
        text: 'Runs 378 and 379 did work and reported 452 rows.',
        expected: [
          ['378', 'EVIDENCE'],
          ['379', 'UNCLASSIFIED'],
          ['452', 'UNCLASSIFIED'],
        ],
      },
      { text: 'The 3rd retry succeeded.', expected: [] },
      { text: '1. First item.', expected: [] },
      { text: 'Open https://localhost:7778/v2 now.', expected: [] },
      { text: 'Read /tmp/run-42/file2.ts.', expected: [] },
      { text: 'Use `port 8888`.', expected: [] },
      { text: '```\nhidden 9000\n```', expected: [] },
      { text: 'Ticket DEV-307 owns this.', expected: [] },
      { text: 'Recorded on 2026-09-06.', expected: [] },
      { text: 'The meeting starts at 13:20.', expected: [] },
      { text: 'See file.ts:42 and path/file:43.', expected: [] },
      { text: 'See lines 19-21.', expected: [] },
      {
        text: 'Install Bun 1.3.14 before running the gate.',
        expected: [['1.3.14', 'RESTATED']],
      },
      {
        text: 'The gate checks 50 files and Bun 1.3.14 is installed.',
        expected: [
          ['50', 'CHECKED'],
          ['1.3.14', 'RESTATED'],
        ],
      },
      {
        text: 'Run 7 measured 40 rows, but the suite has 900 tests.',
        expected: [
          ['7', 'EVIDENCE'],
          ['40', 'EVIDENCE'],
          ['900', 'RESTATED'],
        ],
      },
      {
        text: 'The year 2020 changed everything.',
        expected: [['2020', 'UNCLASSIFIED']],
      },
    ]
    for (const row of cases) {
      const report = numericLiteralReport(row.text, 'fixture')
      expect(
        report.map(({ numeral, classification }) => [numeral, classification]),
        row.text,
      ).toEqual(row.expected)
      expect(report.every((hit) => hit.source === 'fixture')).toBe(true)
    }
  })

  test('canon check keeps its exit-zero JSON contract for a missing cwd', () => {
    const missing = join(dir, 'numeric-missing-cwd')
    expect(
      findingsForPack(compilePack({ job: 'understand', cwd: missing })).flatMap(
        (row) => row.findings,
      ),
    ).toEqual([])
    expect(inspectNumericLiterals(missing)).toEqual({
      numericLiterals: [],
      canonFiles: { read: [], missing: [] },
    })
  })
})
