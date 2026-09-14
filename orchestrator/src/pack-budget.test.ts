import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDoc } from '../test/fixtures/docs.ts'
import { dir } from '../test/fixtures/store.ts'
import { CanonBudgetError, compilePack } from './canon.ts'
import { JOBS } from './jobs.ts'
import { upsertProject } from './projects.ts'
import { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } from './pack-budget.ts'
import { checkPackBudget } from '../scripts/check-pack-budget.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

/**
 * Walk THIS tree's sources, not every copy of them on disk.
 *
 * `.claude/worktrees` and `orchestrator/runs` both hold whole copies of the
 * source tree - a retained worker worktree, and a run's archived artifacts.
 * Descending into them made this invariant measure repository HISTORY: 152
 * assignments were reported where one was expected, because worktrees cut
 * before DEFAULT_PACK_BYTES moved out of jobs.ts still carry the old
 * assignment. It also pushed the walk past its 5s budget at 6547ms.
 *
 * Excluding them by name is deliberate rather than clever: the alternative,
 * a gitignore-aware walk, would silently change what this invariant covers
 * whenever the ignore file changes.
 */
const UNWALKED = new Set(['node_modules', 'dist', '.claude', 'runs'])

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (UNWALKED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('canon pack budget', () => {
  test('DEFAULT_PACK_BYTES is assigned in one module and imported by the gate, dispatch and set_doc', () => {
    const files = walkTs(ROOT)
    const assignments = files.filter((path) =>
      /export const DEFAULT_PACK_BYTES\s*=/.test(readFileSync(path, 'utf8')))
    expect(assignments.map((path) => path.slice(ROOT.length + 1))).toEqual([
      'orchestrator/src/pack-budget.ts',
    ])
    expect(readFileSync(join(ROOT, 'orchestrator/src/jobs.ts'), 'utf8'))
      .toContain("from './pack-budget.ts'")
    expect(readFileSync(join(ROOT, 'orchestrator/src/docs.ts'), 'utf8'))
      .toContain("from './pack-budget.ts'")
    expect(readFileSync(join(ROOT, 'orchestrator/scripts/check-pack-budget.ts'), 'utf8'))
      .toContain("from '../src/pack-budget.ts'")
    expect(DEFAULT_PACK_BYTES).toBe(64 * 1024)
    expect(MAX_INJECT_DOC_BYTES).toBe(8 * 1024)
  })

  test('a pack one byte over fails the gate naming the largest item; one byte under passes', () => {
    upsertProject({ name: 'pack-budget', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global', subject: null, slug: 'largest', title: 'Largest',
      body: 'L'.repeat(40),
    })
    setDoc({
      scope: 'global', subject: null, slug: 'smallest', title: 'Smallest',
      body: 's',
    })
    const old = JOBS.understand!.packBytes
    const measured = compilePack({ job: 'understand', cwd: dir })
    JOBS.understand!.packBytes = measured.bytes - 1
    try {
      expect(() => compilePack({ job: 'understand', cwd: dir })).toThrow(CanonBudgetError)
      let message = ''
      try { compilePack({ job: 'understand', cwd: dir }) }
      catch (error) { message = (error as Error).message }
      expect(message).toContain('global/_/largest')
      expect(message.indexOf('global/_/largest')).toBeLessThan(message.indexOf('global/_/smallest'))
      const failures = checkPackBudget()
      expect(failures.some((row) => row.includes('global/_/largest'))).toBe(true)
    } finally {
      JOBS.understand!.packBytes = measured.bytes
    }
    expect(() => compilePack({ job: 'understand', cwd: dir })).not.toThrow()
    JOBS.understand!.packBytes = old
  })

  test('a small inject write is refused when its affected pack would cross the ceiling', () => {
    upsertProject({ name: 'proposed-pack-budget', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global', subject: null, slug: 'pack-base', title: 'Pack base',
      body: 'b'.repeat(2_000),
    })
    const old = JOBS['file-question']!.packBytes
    JOBS['file-question']!.packBytes = compilePack({ job: 'file-question', cwd: dir }).bytes + 5_000
    try {
      expect(() => setDoc({
        scope: 'job', subject: 'file-question', slug: 'six-kib', title: 'Six KiB',
        body: 'x'.repeat(6 * 1024),
      })).toThrow(/canon pack file-question\/[^ ]+ would be .* bytes over.*largest inject sections to demote/s)
    } finally {
      JOBS['file-question']!.packBytes = old
    }
  })

  const script = join(ROOT, 'orchestrator/scripts/check-pack-budget.ts')
  const runBudget = (orchDb: string | undefined) => Bun.spawnSync(
    [process.execPath, script],
    {
      env: { ...process.env, ...(orchDb === undefined ? {} : { ORCH_DB: orchDb }) },
      stdout: 'pipe', stderr: 'pipe',
    },
  )

  test('the CLI reads a current store in place and says so', () => {
    const result = runBudget(process.env.ORCH_DB)
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain('canon pack budget: reading live store in place (read-only)')
    expect(result.stdout.toString()).toContain('canon pack budget ok')
  })

  test('the CLI mints a fixture store when there is no live store', () => {
    const result = runBudget(join(tmpdir(), 'orch-pack-budget-missing', 'orch.db'))
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain('canon pack budget: no live store; checking fixture-minted store')
    expect(result.stdout.toString()).toContain('canon pack budget ok')
  })

  test('the CLI copies a behind live store, migrates the copy, and checks packs there', () => {
    const folder = mkdtempSync(join(tmpdir(), 'orch-pack-behind-journal-'))
    try {
      mkdirSync(join(folder, 'meta'))
      const prefix = migrationJournal().slice(0, -1)
      for (const entry of prefix) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
      }
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
        version: '7', dialect: 'sqlite', entries: prefix,
      }))
      const store = join(folder, 'behind.db')
      const d = new Database(store)
      d.exec('PRAGMA foreign_keys=ON')
      applyMigrations(d, folder)
      d.close()
      const result = runBudget(store)
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain(
        'canon pack budget: copied live store, migrated the copy, checking packs there',
      )
      expect(result.stdout.toString()).toContain('canon pack budget ok')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
