import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydrationDrift, planHydration } from '../orchestrator/src/canon/canon-hydrate.ts'
import { cloneRepository, runTestGit } from '../shared/test-git-repository.ts'
import { resolveRegisteredLandingBase } from './landing-base.ts'

let scratch: string | null = null
const originalGithubBase = process.env.GITHUB_BASE_REF
const originalOrchDatabase = process.env.ORCH_DB
let databaseScratch = ''
let openReadOnlyDatabase: typeof import('../orchestrator/src/database/db.ts').openReadOnlyDatabase
let branchChangedPaths: typeof import('./check-canon-drift.ts').branchChangedPaths
let branchHydrationPaths: typeof import('./check-canon-drift.ts').branchHydrationPaths
let canonBranchFindings: typeof import('./check-canon-drift.ts').canonBranchFindings
let readCanonGateInput: typeof import('./check-canon-drift.ts').readCanonGateInput

beforeAll(async () => {
  databaseScratch = mkdtempSync(join(tmpdir(), 'canon-drift-database-'))
  process.env.ORCH_DB = join(databaseScratch, 'orch.db')
  ;({ openReadOnlyDatabase } = await import('../orchestrator/src/database/db.ts'))
  ;({ branchChangedPaths, branchHydrationPaths, canonBranchFindings, readCanonGateInput } =
    await import('./check-canon-drift.ts'))
})

afterAll(() => {
  if (originalOrchDatabase === undefined) delete process.env.ORCH_DB
  else process.env.ORCH_DB = originalOrchDatabase
  rmSync(databaseScratch, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  return runTestGit(root, process.env, ...args)
}

function repository(): string {
  scratch = cloneRepository(process.env, 'canon-drift-gate-')
  return scratch
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A')
  git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

afterEach(() => {
  scratch = null
  if (originalGithubBase === undefined) delete process.env.GITHUB_BASE_REF
  else process.env.GITHUB_BASE_REF = originalGithubBase
})

describe('canon drift branch gate', () => {
  test('checks the Codex project doc when one of its hydrated sources changes', () => {
    const plan = planHydration({
      rows: [
        { slug: 'AGENTS.md', body: 'Entry.\n' },
        { slug: '.agents/rules/example.md', body: 'Rule.\n' },
      ],
      tree: [
        { path: 'AGENTS.md', text: 'Entry.\n' },
        { path: '.agents/rules/example.md', text: 'Rule.\n' },
        { path: 'AGENTS.override.md', text: 'stale\n' },
      ],
    })

    expect(hydrationDrift(plan, branchHydrationPaths(['.agents/rules/example.md']))).toEqual([
      { path: 'AGENTS.override.md', operation: 'write' },
    ])
  })

  test('compares committed HEAD even when the working copy matches stored canon', () => {
    const root = repository()
    writeFileSync(join(root, 'AGENTS.md'), 'stored\n')
    const base = commit(root, 'base')
    writeFileSync(join(root, 'AGENTS.md'), 'committed drift\n')
    commit(root, 'drift')
    writeFileSync(join(root, 'AGENTS.md'), 'stored\n')

    expect(
      canonBranchFindings({
        checkout: root,
        base,
        rows: [{ slug: 'AGENTS.md', body: 'stored\n' }],
      }),
    ).toEqual([
      { path: 'AGENTS.md', operation: 'write' },
      { path: 'AGENTS.override.md', operation: 'write' },
    ])
  })

  test('treats moves out of both canon namespaces as removals', () => {
    const root = repository()
    mkdirSync(join(root, '.agents/rules'), { recursive: true })
    writeFileSync(join(root, '.agents/rules/example.md'), 'rule\n')
    writeFileSync(join(root, 'AGENTS.md'), 'card\n')
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
    const base = commit(root, 'base')
    mkdirSync(join(root, '.agents/skills'), { recursive: true })
    git(root, 'mv', '.agents/rules/example.md', '.agents/skills/example.md')
    git(root, 'mv', 'CLAUDE.md', 'CLAUDE-away.md')
    commit(root, 'move canon away')

    const changed = branchChangedPaths(root, base)
    expect(changed).toContain('.agents/rules/example.md')
    expect(changed).toContain('CLAUDE.md')
    expect(
      canonBranchFindings({
        checkout: root,
        base,
        rows: [
          { slug: '.agents/rules/example.md', body: 'rule\n' },
          { slug: 'AGENTS.md', body: 'card\n' },
        ],
      }),
    ).toEqual([
      { path: '.agents/rules/example.md', operation: 'write' },
      { path: 'AGENTS.override.md', operation: 'write' },
      { path: 'CLAUDE.md', operation: 'link' },
    ])
  })

  test('reads register and canon rows without changing a scratch store', () => {
    const root = repository()
    const store = join(root, 'scratch.db')
    const writable = new Database(store, { create: true })
    writable.exec(`
      CREATE TABLE project (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, stack TEXT,
        canon INTEGER NOT NULL DEFAULT 0, settings TEXT, retired_at TEXT
      );
      CREATE TABLE doc (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, subject TEXT, owner TEXT,
        project_id INTEGER, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        delivery TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        record_id TEXT, revision TEXT, audience TEXT NOT NULL DEFAULT 'technical',
        parent_id INTEGER, position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE doc_revision (id INTEGER PRIMARY KEY, doc_id INTEGER, record_id TEXT);
    `)
    writable
      .query('INSERT INTO project (name,path,canon,settings) VALUES (?,?,1,?)')
      .run('fixture', root, JSON.stringify({ trunk: 'main' }))
    writable.close()
    const digest = () => createHash('sha256').update(readFileSync(store)).digest('hex')
    const before = digest()

    const readonly = openReadOnlyDatabase(store)
    expect(readCanonGateInput(root, readonly)).toMatchObject({
      project: { name: 'fixture' },
      rows: [],
    })
    readonly.close()

    expect(digest()).toBe(before)
  })

  test('refuses CI base metadata that differs from registered trunk', () => {
    process.env.GITHUB_BASE_REF = 'release'
    expect(() => resolveRegisteredLandingBase('/unused', 'canon drift check', 'main')).toThrow(
      'GITHUB_BASE_REF release: the project register names main as trunk',
    )
  })
})
