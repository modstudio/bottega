import { Database } from 'bun:sqlite'
import { describe,expect,test } from 'bun:test'
import { existsSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db,listPairs,planImport,projects,runWithDelayedStdoutReader,sourceCoverage,upsertProject } from '../fixture.ts'

describe('port importer', () => {
const registered = () => {
    upsertProject({ name: 'alpha-invented', path: '/w/alpha-invented', settings: { keyPrefixes: ['ALP'] } })
    upsertProject({ name: 'beta-invented', path: '/w/beta-invented', settings: { keyPrefixes: ['BET'] } })
    return projects()
  }
const fixture = (overrides: Partial<Record<'doctrine' | 'differences' | 'backports' | 'refs' | 'state' | 'projects', string>> = {}) => ({
    doctrine: '# Doctrine\n\nPreface text.\n\n1. **Keep the whole rule** Opening sentence.\nContinuation line.\nA known final item at the end of the rule.\n',
    differences: '# Differences\n\n## Stack mapping (how to translate, not a reason to skip)\nMap body.\n\n## Per-project uniques\n\n### alpha-invented\nAlpha body.\n\n### Shared deployment constraint\nUnassigned body.\n\n### beta-invented\nBeta body.\n\n## Process differences\nProcess body.\n',
    backports: '# Backports\n\n## -> alpha-invented\n' + 'A long backport body. '.repeat(20) + '\nKnown final checkbox.\n\n## -> beta-invented\nBeta backport.\n',
    refs: JSON.stringify({ 'BET-7': { source: 'alpha-invented', commits: ['abc'], paths: ['src/a.ts'], notes: 'Native notes.' } }),
    state: JSON.stringify({ pairs: { 'alpha-invented->beta-invented': { lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [{ feature: 'old feature', reason: 'superseded', raiseAgain: false }] } } }),
    projects: '# Projects\n\n## Category map\nCategories.\n\n## Reference implementations (deepest instance = default port source)\nReferences.\n',
    ...overrides,
  })
test('CLI dry-run shows body lengths, writes nothing, and names a missing file', () => {
    registered()
    const source = mkdtempSync(join(tmpdir(), 'port-import-invented-'))
    try {
      for (const [name, body] of Object.entries(fixture())) writeFileSync(join(source, `${name}.json`), body)
      // Markdown inputs have their source filenames rather than the fixture object's uniform suffix.
      for (const name of ['doctrine', 'differences', 'backports', 'projects'] as const) {
        writeFileSync(join(source, `${name}.md`), fixture()[name])
      }
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const run = (path: string) => Bun.spawnSync([process.execPath, CLI, 'port', 'import', path, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      const sessionsBefore = db().query('SELECT COUNT(*) n FROM session_seen').get()
      const clean = run(source)
      expect(clean.exitCode).toBe(0)
      const cleanPlan = JSON.parse(clean.stdout.toString())
      expect(cleanPlan.docs[0].bodyLength).toBeGreaterThan(0)
      expect(cleanPlan.uncoveredSpans).toEqual([])
      const human = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(human.exitCode).toBe(0)
      expect(human.stdout.toString()).toContain('uncovered spans (0)')
      expect(listPairs()).toEqual([])
      expect(db().query('SELECT COUNT(*) n FROM session_seen').get()).toEqual(sessionsBefore)

      const incomplete = mkdtempSync(join(tmpdir(), 'port-import-missing-invented-'))
      try {
        const missing = run(incomplete)
        expect(missing.exitCode).toBe(1)
        const missingPlan = JSON.parse(missing.stdout.toString())
        expect(missingPlan.refusals).toHaveLength(6)
        expect(missingPlan.refusals.every((issue: any) => issue.what.startsWith('source file'))).toBe(true)
        expect(missingPlan.refusals.map((issue: any) => issue.where)).toContain(join(incomplete, 'refs.json'))
        expect(missingPlan.uncoveredSpans).toHaveLength(6)
      } finally { rmSync(incomplete, { recursive: true, force: true }) }
    } finally { rmSync(source, { recursive: true, force: true }) }
  })
test('CLI dry-run pipes a complete large JSON refusal plan', async () => {
    registered()
    const source = mkdtempSync(join(tmpdir(), 'port-import-large-refusal-invented-'))
    try {
      const contents = fixture({
        refs: JSON.stringify({
          'BET-7': {
            source: 'missing-invented', commits: [], paths: [], notes: 'unresolved source',
          },
        }),
        state: JSON.stringify({ pairs: {
          'alpha-invented->beta-invented': {
            lastPortedSha: 'abc', scannedAt: '2026-01-01', skipped: [],
            note: 'large-excluded-value-'.repeat(3_500),
          },
        } }),
      })
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)

      const planned = planImport(contents, projects())
      const expected = Buffer.from(`${JSON.stringify({
        ...planned,
        doctrine: planned.doctrine.map((row) => ({ ...row, bodyLength: row.body.length })),
        docs: planned.docs.map((row) => ({ ...row, bodyLength: row.body.length })),
        uncoveredSpans: sourceCoverage(planned, contents),
      }, null, 2)}\n`)
      const cli = new URL('../../src/orch.ts', import.meta.url).pathname
      const run = await runWithDelayedStdoutReader(
        [process.execPath, cli, 'port', 'import', source, '--dry-run', '--json'],
        { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      )
      expect(expected.byteLength).toBeGreaterThan(65_536)
      expect(run.stdout.byteLength).toBe(expected.byteLength)
      expect(run.stdout.equals(expected)).toBe(true)
      const plan = JSON.parse(run.stdout.toString())
      expect(plan.refusals).toContainEqual(expect.objectContaining({
        what: 'project "missing-invented"',
      }))
      expect(plan.exclusions[0].value).toHaveLength('large-excluded-value-'.length * 3_500)
      expect(run.exitCode).toBe(1)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })
test('CLI dry-run refuses a nonexistent database without creating any SQLite files', () => {
    const source = mkdtempSync(join(tmpdir(), 'port-import-readonly-invented-'))
    const absent = join(source, 'absent.db')
    try {
      const contents = fixture()
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const run = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: absent, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(run.exitCode).toBe(1)
      expect(run.stdout.toString()).toContain('orchestrator database does not exist')
      expect(existsSync(absent)).toBe(false)
      expect(existsSync(`${absent}-wal`)).toBe(false)
      expect(existsSync(`${absent}-shm`)).toBe(false)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })
test('CLI dry-run explains a WAL database whose shared-memory sidecar is absent', () => {
    const source = mkdtempSync(join(tmpdir(), 'port-import-wal-invented-'))
    const walPath = join(source, 'wal-copy.db')
    try {
      const contents = fixture()
      for (const [name, body] of Object.entries({
        'doctrine.md': contents.doctrine, 'differences.md': contents.differences,
        'backports.md': contents.backports, 'refs.json': contents.refs,
        'state.json': contents.state, 'projects.md': contents.projects,
      })) writeFileSync(join(source, name), body)
      const wal = new Database(walPath)
      wal.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE project (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
          stack TEXT, canon INTEGER NOT NULL, settings TEXT
        );
        PRAGMA wal_checkpoint(TRUNCATE);
      `)
      wal.close()
      rmSync(`${walPath}-shm`, { force: true })
      rmSync(`${walPath}-wal`, { force: true })
      expect(existsSync(`${walPath}-shm`)).toBe(false)

      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const run = Bun.spawnSync([process.execPath, CLI, 'port', 'import', source, '--dry-run', '--json'], {
        env: { ...process.env, ORCH_DB: walPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(run.exitCode).toBe(1)
      const why = JSON.parse(run.stdout.toString()).refusals[0].why
      expect(why).toContain(`WAL-mode with no ${walPath}-shm sidecar`)
      expect(why).toContain('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(why).toContain('Underlying error: SQLiteError: unable to open database file')
      expect(existsSync(`${walPath}-shm`)).toBe(false)
      expect(existsSync(`${walPath}-wal`)).toBe(false)
    } finally { rmSync(source, { recursive: true, force: true }) }
  })
})
