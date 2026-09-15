import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { searchRecords, searchSnippet } from './search.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE run (
      id INTEGER PRIMARY KEY, parent_run_id INTEGER, launch_key TEXT,
      started_at TEXT NOT NULL, output_path TEXT
    );
    CREATE TABLE score (id INTEGER PRIMARY KEY, run_id INTEGER, note TEXT);
    CREATE TABLE question (
      id INTEGER PRIMARY KEY, run_id INTEGER, question TEXT, options TEXT,
      recommendation TEXT, why TEXT, answer TEXT
    );
    CREATE TABLE review_lens (id INTEGER PRIMARY KEY, run_id INTEGER);
    CREATE TABLE review_finding (
      id INTEGER PRIMARY KEY, review_lens_id INTEGER, severity TEXT, location TEXT, evidence TEXT,
      proposed_correction TEXT, disposition TEXT, rejection_category TEXT
    );
  `)
  return d
}

describe('record search', () => {
  test('task keys directly link every kind of existing record without returning whole notes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-search-'))
    dirs.push(dir)
    const output = join(dir, 'output.txt')
    writeFileSync(output, `worker established ${'long '.repeat(80)}result`)
    const d = fixture()
    d.exec(`
      INSERT INTO run VALUES (1, NULL, 'DEV-203', '2026-09-01T00:00:00Z', '${output}');
      INSERT INTO score VALUES (1, 1, 'A substantial scoring note that does not repeat its task key.');
      INSERT INTO question VALUES (1, 1, 'Which primitive?', NULL, NULL, NULL, 'Use read-tree.');
      INSERT INTO review_lens VALUES (1, 1);
      INSERT INTO review_finding VALUES (1, 1, 'major', 'file.ts:4', 'The guard is process-local.', 'Move it to the repository hook.', 'accepted', NULL);
    `)

    const found = searchRecords(d, 'dev-203')
    expect(found.results.map((result) => result.source)).toEqual([
      'score',
      'ruling',
      'review',
      'output',
    ])
    expect(found.results.every((result) => result.match === 'direct task link')).toBe(true)
    expect(
      found.results.find((result) => result.source === 'output')!.snippet.length,
    ).toBeLessThanOrEqual(242)
  })

  test('file and function searches are literal and honestly marked weak', () => {
    const d = fixture()
    d.exec(`
      INSERT INTO run VALUES (1, NULL, 'DEV-1', '2026-09-01T00:00:00Z', NULL);
      INSERT INTO score VALUES (1, 1, 'Checked resolveBase() in orchestrator/src/worktree.ts:44; it preserves HEAD.');
    `)

    const file = searchRecords(d, 'orchestrator/src/worktree.ts')
    const fn = searchRecords(d, 'resolveBase()')
    expect(file.results[0]?.match).toBe('literal text match (weak relevance)')
    expect(fn.results[0]?.snippet).toContain('resolveBase()')
  })

  test('missing output files are reported instead of silently treated as searchable', () => {
    const d = fixture()
    d.exec(
      `INSERT INTO run VALUES (1, NULL, 'DEV-1', '2026-09-01T00:00:00Z', '/definitely/missing/output')`,
    )
    const found = searchRecords(d, 'anything')
    expect(found.results).toEqual([])
    expect(found.unavailable_outputs).toBe(1)
  })

  test('full records are opt-in', () => {
    const d = fixture()
    d.exec(`
      INSERT INTO run VALUES (1, NULL, 'DEV-1', '2026-09-01T00:00:00Z', NULL);
      INSERT INTO score VALUES (1, 1, 'the complete note');
    `)
    expect(searchRecords(d, 'complete').results[0]).not.toHaveProperty('content')
    expect(searchRecords(d, 'complete', 20, true).results[0]?.content).toBe('the complete note')
  })

  test('snippets put a late match in view', () => {
    const snippet = searchSnippet(`${'before '.repeat(80)}needle after`, 'needle', false)
    expect(snippet).toStartWith('…')
    expect(snippet).toContain('needle')
  })
})
