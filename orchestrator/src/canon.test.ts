import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySchema, db } from '../test/fixture.ts'

describe('canonical schema rebuild', () => {
  /**
   * The CREATE TABLE migrate() used to ship, before every grafted column was
   * folded in. Copied, not reconstructed, so the rebuild is tested against the
   * definition an existing file actually has.
   */
  const OLD_RUN_DDL = `CREATE TABLE IF NOT EXISTS run (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      agent         TEXT NOT NULL,
      job           TEXT NOT NULL,
      repo          TEXT,
      cwd           TEXT,
      prompt_sha    TEXT NOT NULL,
      prompt_bytes  INTEGER NOT NULL,
      prompt_head   TEXT NOT NULL,
      latency_ms    INTEGER,
      exit_code     INTEGER,
      output_bytes  INTEGER,
      output_path   TEXT,
      prompt_path   TEXT,
      vendor_tokens INTEGER,
      vendor_cost_usd REAL,
      probe         INTEGER NOT NULL DEFAULT 0,
      failure_kind  TEXT,
      status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','failed','stale','asking','blocked')),
      error         TEXT
    )`
  const OLD_SCORE_DDL = `CREATE TABLE IF NOT EXISTS score (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      delivery  TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
      quality   TEXT CHECK (quality IN ('wrong','mixed','right')),
      fidelity  TEXT,
      note      TEXT,
      scored_at TEXT NOT NULL,
      scored_by TEXT NOT NULL DEFAULT 'claude',
      CHECK ((delivery = 'none') = (quality IS NULL))
    )`
  const OLD_DOC_DDL = `CREATE TABLE IF NOT EXISTS doc (
      id         INTEGER PRIMARY KEY,
      scope      TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global')),
      subject    TEXT,
      slug       TEXT NOT NULL CHECK (
                   length(slug) <= 64 AND
                   slug GLOB '[a-z0-9]*' AND
                   slug NOT GLOB '*[^a-z0-9-]*'
                 ),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope IN ('machine','global') AND subject IS NULL) OR
             (scope IN ('project','agent','job') AND subject IS NOT NULL)),
      UNIQUE(scope, subject, slug)
    )`
  const OLD_REVIEW_LENS_DDL = `CREATE TABLE review_lens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
      lens TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      tree_inspected TEXT NOT NULL,
      standards_read TEXT NOT NULL,
      files_covered TEXT NOT NULL,
      commands_run TEXT NOT NULL,
      could_not_verify TEXT NOT NULL
    )`
  const LIVE_REVIEW_FINDING_DDL = `CREATE TABLE review_finding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
      review_lens_id INTEGER NOT NULL REFERENCES review_lens(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      severity TEXT NOT NULL,
      location TEXT NOT NULL,
      evidence TEXT NOT NULL,
      proposed_correction TEXT NOT NULL,
      disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted','modified','rejected','skipped')),
      rejection_category TEXT,
      triaged_at TEXT,
      UNIQUE(review_id, ordinal),
      CHECK (disposition = 'rejected' OR rejection_category IS NULL)
    )`

  const cols = (d: Database, table: string) =>
    (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

  const tableSql = (d: Database, name: string) =>
    (d.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { sql: string }).sql

  const metaVersion = (d: Database) =>
    (d.query(`SELECT value FROM schema_meta WHERE key='schema'`).get() as { value: string } | null)?.value ?? null

  const replaceTableForFixture = (
    d: Database, name: string, alter: (sql: string) => string,
  ) => {
    const replacement = `${name}_fixture`
    const ddl = alter(tableSql(d, name).replace(
      /^CREATE TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/,
      `CREATE TABLE ${replacement}`,
    ))
    const cols = (d.query(`PRAGMA table_info(${name})`).all() as { name: string }[])
      .map((column) => `"${column.name}"`).join(', ')
    d.exec('PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE')
    try {
      d.exec(ddl)
      d.exec(`INSERT INTO ${replacement} (${cols}) SELECT ${cols} FROM ${name}`)
      d.exec(`DROP TABLE ${name}; ALTER TABLE ${replacement} RENAME TO ${name}; COMMIT`)
    } catch (error) {
      d.exec('ROLLBACK')
      throw error
    } finally {
      d.exec('PRAGMA foreign_keys=ON')
    }
  }

  function openOld(path: string): Database {
    const d = new Database(path)
    d.exec('PRAGMA foreign_keys=ON')
    d.exec(OLD_RUN_DDL)
    d.exec(OLD_SCORE_DDL)
    d.exec('CREATE TABLE review (id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at TEXT NOT NULL, completed_at TEXT)')
    d.exec(OLD_REVIEW_LENS_DDL)
    d.exec(LIVE_REVIEW_FINDING_DDL)
    d.exec(
      `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('2026-01-01T00:00:00.000Z', 'codex', 'implement', 'sha', 10, 'keep-me', 'blocked')`,
    )
    d.exec(
      `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
       VALUES (1, 'full', 'right', 'faithful', '2026-01-01T00:00:00.000Z')`,
    )
    d.exec("INSERT INTO review VALUES (1, '2026-01-01T00:00:00.000Z', NULL)")
    d.exec("INSERT INTO review_lens VALUES (1, 1, 1, 'legacy', 'codex', 'old', 'claimed', '[]', '[]', '[]', '[]')")
    d.exec("INSERT INTO review_finding (review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction) VALUES (1,1,1,'major','old.ts:1','retained evidence','fix it')")
    applySchema(d)
    return d
  }

  test('an old database opens, is rebuilt, keeps its rows, and enforces the new CHECKs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'old.db')
    const d = openOld(path)
    expect(cols(d, 'run')).toEqual(cols(db(), 'run'))
    expect(cols(d, 'run')).toContain('head_commit')
    expect(cols(d, 'run')).toContain('changed_paths')
    expect(cols(d, 'review')).toEqual(cols(db(), 'review'))
    expect(cols(d, 'run')).toContain('review_ref')
    expect(cols(d, 'score')).toEqual(cols(db(), 'score'))
    expect(cols(d, 'review_lens')).toEqual(cols(db(), 'review_lens'))
    expect(cols(d, 'landing_override')).toEqual(cols(db(), 'landing_override'))
    expect(cols(d, 'landing_review_carry')).toEqual(cols(db(), 'landing_review_carry'))
    expect(d.query('SELECT id, prompt_head, status FROM run').get()).toEqual(
      { id: 1, prompt_head: 'keep-me', status: 'asking' },
    )
    expect(d.query('SELECT fidelity FROM score WHERE run_id=1').get()).toEqual({ fidelity: 'faithful' })
    expect(d.query(
      `SELECT tree_inspected, reviewed_tree, reproduced, coverage, limits, overlap
         FROM review_lens WHERE id=1`,
    ).get()).toEqual({
      tree_inspected: 'claimed', reviewed_tree: null,
      reproduced: null, coverage: null, limits: null, overlap: null,
    })
    expect(d.query('SELECT triaged_severity FROM review_finding WHERE id=1').get())
      .toEqual({ triaged_severity: null })
    expect((d.query('PRAGMA table_info(review_lens)').all() as { name: string; notnull: number }[])
      .find((column) => column.name === 'tree_inspected')?.notnull).toBe(0)
    const uniqueIndexes = (d.query('PRAGMA index_list(review_lens)').all() as
      { name: string; unique: number }[]).filter((index) => index.unique === 1)
    expect(uniqueIndexes.some((index) =>
      (d.query(`PRAGMA index_info(${index.name})`).all() as { name: string }[])
        .map((column) => column.name).join(',') === 'run_id')).toBe(true)
    expect(d.query(
      `SELECT rf.evidence, rl.tree_inspected
         FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
        WHERE rf.id=1`,
    ).get()).toEqual({ evidence: 'retained evidence', tree_inspected: 'claimed' })
    expect(d.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() => d.query(
      `INSERT INTO landing_override (project,branch,tip,tree,reason,at)
       VALUES ('p','b','tip','tree',?,'now')`,
    ).run('   ')).toThrow()
    expect(() => d.exec("UPDATE run SET status='blocked' WHERE id=1")).toThrow()
    expect(() => d.exec("UPDATE score SET fidelity='typo' WHERE run_id=1")).toThrow()
    d.close()
  })

  test('a fresh database opens without a rebuild (meta version matches)', () => {
    const sql = tableSql(db(), 'run')
    expect(sql.startsWith('CREATE TABLE run')).toBe(true)
    expect(sql.startsWith('CREATE TABLE "run"')).toBe(false)
    const version = metaVersion(db())
    expect(version).toMatch(/^[0-9a-f]{64}$/)
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'fresh.db')
    const d = new Database(path)
    applySchema(d)
    expect(metaVersion(d)).toBe(version)
    const freshSql = tableSql(d, 'run')
    expect(freshSql.startsWith('CREATE TABLE run')).toBe(true)
    expect(freshSql.startsWith('CREATE TABLE "run"')).toBe(false)
    d.close()
  })

  test('a run-only rebuild ignores identifier quotes and preserves unrelated table SQL and sequence', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-run-only-')), 'fixture.db')
    let d = new Database(path)
    applySchema(d)
    d.exec(`
      INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('2026-01-01T00:00:00.000Z','codex','implement','sha',1,'run','ok');
      INSERT INTO score (run_id,delivery,quality,fidelity,scored_at)
      VALUES (1,'full','right','faithful','2026-01-01T00:00:00.000Z');
    `)
    const untouched = ['score', 'doc', 'review_lens', 'review_finding']
    for (const name of untouched) {
      d.exec(`ALTER TABLE ${name} RENAME TO ${name}_quoted; ALTER TABLE ${name}_quoted RENAME TO ${name}`)
    }
    d.exec("UPDATE sqlite_sequence SET seq=1414 WHERE name='score'")
    replaceTableForFixture(
      d, 'run', (sql) => sql.replace(
        "'running','ok','failed','stale','asking','stopped'))",
        "'running','ok','failed','stale','asking','stopped','blocked'))",
      ),
    )
    d.exec("UPDATE schema_meta SET value='run-only-change' WHERE key='schema'")
    d.close()

    d = new Database(path)
    const before = Object.fromEntries(untouched.map((name) => [name, tableSql(d, name)]))
    applySchema(d)
    expect(Object.fromEntries(untouched.map((name) => [name, tableSql(d, name)]))).toEqual(before)
    expect(d.query("SELECT seq FROM sqlite_sequence WHERE name='score'").get()).toEqual({ seq: 1414 })
    expect(tableSql(d, 'run')).not.toContain("'blocked'")
    d.close()
  })

  test('a genuine table rebuild preserves its autoincrement high watermark', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-sequence-')), 'fixture.db')
    let d = new Database(path)
    applySchema(d)
    d.exec(`
      INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('2026-01-01T00:00:00.000Z','codex','implement','sha',1,'run','ok');
      INSERT INTO score (run_id,delivery,quality,fidelity,scored_at)
      VALUES (1,'full','right','faithful','2026-01-01T00:00:00.000Z');
    `)
    replaceTableForFixture(
      d, 'score', (sql) => sql.replace(
        "'faithful','drifted'))", "'faithful','drifted','legacy'))",
      ),
    )
    d.exec("UPDATE sqlite_sequence SET seq=1414 WHERE name='score'")
    d.exec("UPDATE schema_meta SET value='score-change' WHERE key='schema'")
    d.close()

    d = new Database(path)
    applySchema(d)
    expect(d.query("SELECT seq FROM sqlite_sequence WHERE name='score'").get()).toEqual({ seq: 1414 })
    d.exec(`INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
            VALUES ('2026-01-02','codex','implement','sha2',1,'next','ok')`)
    d.exec(`INSERT INTO score (run_id,delivery,quality,fidelity,scored_at)
            VALUES (2,'full','right','faithful','2026-01-02')`)
    expect(d.query('SELECT MAX(id) AS id FROM score').get()).toEqual({ id: 1415 })
    d.close()
  })

  test('fresh and upgraded question tables have identical column order', () => {
    const upgradedPath = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'upgraded.db')
    const upgraded = new Database(upgradedPath)
    upgraded.exec(`CREATE TABLE question (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
      asked_at TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT,
      recommendation TEXT,
      why TEXT,
      answer TEXT,
      answered_at TEXT,
      answered_by TEXT
    )`)
    applySchema(upgraded)

    const freshPath = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'fresh-question.db')
    const fresh = new Database(freshPath)
    applySchema(fresh)

    expect(cols(upgraded, 'question')).toEqual(cols(fresh, 'question'))
    expect(cols(fresh, 'question').slice(-2)).toEqual(['answered_by', 'delivery_pending_at'])
    upgraded.close()
    fresh.close()
  })

  test('a rebuild refuses to drop a live column from a newer store', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-newer-')), 'newer.db')
    const d = new Database(path)
    applySchema(d)
    d.exec('ALTER TABLE run ADD COLUMN future_evidence TEXT')
    d.exec("UPDATE schema_meta SET value='older-binary' WHERE key='schema'")
    expect(() => applySchema(d)).toThrow(
      'live column(s) future_evidence would be dropped by a rebuild; this binary is older than the store',
    )
    expect(cols(d, 'run')).toContain('future_evidence')
    d.close()
  })

  test('empty abandoned port tables are replaced rather than left beside the real schema', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'legacy-port.db')
    const d = new Database(path)
    d.exec(`
      CREATE TABLE port_doctrine (n INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE port_ref (
        task_key TEXT PRIMARY KEY, target_project TEXT NOT NULL, source_projects TEXT NOT NULL,
        source_note TEXT, commits TEXT NOT NULL, paths TEXT NOT NULL, notes TEXT,
        created_at TEXT, resolved_at TEXT
      );
      CREATE TABLE port_baseline (
        source_project TEXT NOT NULL, target_project TEXT NOT NULL,
        baseline_sha TEXT, updated_at TEXT, PRIMARY KEY (source_project, target_project)
      );
      CREATE TABLE port_skipped (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_project TEXT NOT NULL,
        target_project TEXT NOT NULL, feature TEXT NOT NULL, note TEXT, created_at TEXT,
        UNIQUE (source_project, target_project, feature)
      );
    `)

    applySchema(d)

    expect(d.query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='port_skipped'`,
    ).get()).toBeNull()
    expect(cols(d, 'port_ref')).toEqual([
      'task_key', 'target_project_id', 'note', 'created_at', 'resolved_at',
    ])
    expect(cols(d, 'port_ref_source')).toContain('source_project_id')
    expect(cols(d, 'port_skip')).toContain('reason')
    expect(cols(d, 'port_doctrine')).toContain('retired_at')
    d.close()
  })

  test('adding ledger resolution state preserves existing provenance rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'pre-resolution-port.db')
    const d = new Database(path)
    d.exec(`
      CREATE TABLE port_ref (
        task_key TEXT PRIMARY KEY,
        target_project_id INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO port_ref VALUES ('TGT-9', 7, 'only copy', '2026-09-03T00:00:00.000Z');
    `)

    applySchema(d)

    expect(d.query('SELECT * FROM port_ref WHERE task_key=?').get('TGT-9')).toEqual({
      task_key: 'TGT-9', target_project_id: 7, note: 'only copy',
      created_at: '2026-09-03T00:00:00.000Z', resolved_at: null,
    })
    d.close()
  })

  test('widening the doc scope CHECK preserves every row and triple', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'old-doc.db')
    const d = new Database(path)
    d.exec(OLD_DOC_DDL)
    d.exec(`
      INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at) VALUES
        ('machine', NULL, 'host', 'Host', 'B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('agent', 'codex', 'mcp', 'MCP', 'C', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    const before = d.query(
      'SELECT id, scope, subject, slug, title, body, created_at, updated_at FROM doc ORDER BY id',
    ).all()
    const triples = d.query(
      'SELECT scope, subject, slug FROM doc ORDER BY scope, subject, slug',
    ).all()
    applySchema(d)
    expect(d.query(
      'SELECT id, scope, subject, slug, title, body, created_at, updated_at FROM doc ORDER BY id',
    ).all()).toEqual(before)
    expect(d.query(
      'SELECT scope, subject, slug FROM doc ORDER BY scope, subject, slug',
    ).all()).toEqual(triples)
    expect(before).toHaveLength(2)
    expect(tableSql(d, 'doc')).toContain("'resume'")
    expect(cols(d, 'doc_revision')).toContain('reason')
    expect(cols(d, 'run')).toContain('doc_revisions')
    expect(cols(d, 'run')).toContain('canon_sha')
    expect(cols(d, 'doc')).toContain('delivery')
    expect(cols(d, 'doc_revision')).toContain('delivery')
    expect(cols(d, 'canon_pack')).toContain('doc_revisions')
    expect(d.query('SELECT doc_id, op, author, reason FROM doc_revision ORDER BY doc_id').all()).toEqual([
      { doc_id: 1, op: 'backfill', author: 'migration', reason: 'state at DEV-256 migration' },
      { doc_id: 2, op: 'backfill', author: 'migration', reason: 'state at DEV-256 migration' },
    ])
    applySchema(d)
    expect(d.query('SELECT COUNT(*) AS n FROM doc_revision').get()).toEqual({ n: 2 })
    d.exec(`INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
            VALUES ('resume', 'known', 'epic', 'T', 'B', 't', 't')`)
    expect(() => d.exec(`INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
            VALUES ('resume', NULL, 'x', 'T', 'B', 't', 't')`)).toThrow()
    d.close()
  })

  test('doc address index rejects NULL-subject duplicates and migration names existing ids', () => {
    const direct = new Database(':memory:')
    applySchema(direct)
    direct.exec(`INSERT INTO doc VALUES (1, 'global', NULL, 'hello', 'T', 'B', 'inject', 't', 't')`)
    expect(() => direct.exec(`INSERT INTO doc VALUES (2, 'global', NULL, 'hello', 'T', 'B', 'inject', 't', 't')`)).toThrow()
    direct.close()

    const legacy = new Database(':memory:')
    legacy.exec(OLD_DOC_DDL)
    legacy.exec(`
      INSERT INTO doc VALUES (7, 'global', NULL, 'hello', 'T', 'B', 't', 't');
      INSERT INTO doc VALUES (9, 'global', NULL, 'hello', 'T', 'B', 't', 't');
    `)
    expect(() => applySchema(legacy)).toThrow('conflicting doc ids: 7,9')
    legacy.close()
  })

  test('delivery migration marks only the five importer metadata slugs demand', () => {
    const legacy = new Database(':memory:')
    legacy.exec(OLD_DOC_DDL)
    const insert = legacy.query(`INSERT INTO doc
      (scope,subject,slug,title,body,created_at,updated_at) VALUES ('global',NULL,?,'T','B','t','t')`)
    for (const slug of ['port-category-map', 'port-import-exclusions', 'port-import-source-context',
      'port-ref-metadata', 'port-state-metadata', 'ordinary']) insert.run(slug)
    applySchema(legacy)
    expect(legacy.query("SELECT slug FROM doc WHERE delivery='demand' ORDER BY slug").all())
      .toEqual(['port-category-map', 'port-import-exclusions', 'port-import-source-context',
        'port-ref-metadata', 'port-state-metadata'].map((slug) => ({ slug })))
    expect(legacy.query("SELECT delivery FROM doc WHERE slug='ordinary'").get()).toEqual({ delivery: 'inject' })
    const revisions = legacy.query(`SELECT op,delivery,author,reason FROM doc_revision
      WHERE slug='port-category-map' AND reason='DEV-254: port importer docs are fetched by slug, not injected'
      ORDER BY id`).all()
    expect(revisions).toEqual([{
      op: 'set', delivery: 'demand', author: 'migration',
      reason: 'DEV-254: port importer docs are fetched by slug, not injected',
    }])
    applySchema(legacy)
    expect(legacy.query(`SELECT COUNT(*) AS n FROM doc_revision WHERE slug='port-category-map'
      AND reason='DEV-254: port importer docs are fetched by slug, not injected'`).get())
      .toEqual({ n: 1 })
    legacy.close()
  })

  test('a noncanonical canon pack is rebuilt before its address index is created', () => {
    const legacy = new Database(':memory:')
    legacy.exec('CREATE TABLE canon_pack (id INTEGER PRIMARY KEY)')
    applySchema(legacy)
    expect(cols(legacy, 'canon_pack')).toContain('job')
    expect(legacy.query("SELECT name FROM sqlite_master WHERE type='index' AND name='canon_pack_address'").get())
      .toEqual({ name: 'canon_pack_address' })
    legacy.close()
  })

  test('old-schema upgrade creates canon_eval', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'canon-eval.db')
    const d = openOld(path)
    expect(cols(d, 'canon_eval')).toEqual(
      ['id', 'slug', 'run_id', 'canon_sha', 'agent', 'model', 'pass', 'why', 'at'],
    )
    d.close()
  })

  test('opening twice is idempotent', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orch-schema-')), 'twice.db')
    const d = openOld(path)
    const first = {
      runSql: tableSql(d, 'run'),
      scoreSql: tableSql(d, 'score'),
      version: metaVersion(d),
      run: d.query('SELECT id, prompt_head, status FROM run').all(),
      score: d.query('SELECT run_id, delivery, quality, fidelity FROM score').all(),
      runCols: cols(d, 'run'),
      scoreCols: cols(d, 'score'),
    }
    applySchema(d)
    expect(tableSql(d, 'run')).toBe(first.runSql)
    expect(tableSql(d, 'score')).toBe(first.scoreSql)
    expect(metaVersion(d)).toBe(first.version)
    expect(d.query('SELECT id, prompt_head, status FROM run').all()).toEqual(first.run)
    expect(d.query('SELECT run_id, delivery, quality, fidelity FROM score').all()).toEqual(first.score)
    expect(cols(d, 'run')).toEqual(first.runCols)
    expect(cols(d, 'score')).toEqual(first.scoreCols)
    d.close()
  })
})
