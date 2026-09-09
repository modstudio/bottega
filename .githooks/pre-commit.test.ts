import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook = join(import.meta.dir, 'pre-commit')
const pythonHook = join(import.meta.dir, '..', 'orchestrator', 'hooks', 'protect-main-checkout.py')
const dirs: string[] = []
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
)

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...gitEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function fixture(options: { registered?: boolean, requireCleanMain?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-commit-'))
  dirs.push(dir)
  const repo = join(dir, 'checkout')
  const hooks = join(repo, '.githooks')
  const pythonHooks = join(repo, 'orchestrator', 'hooks')
  const dbPath = join(dir, 'orch.db')
  mkdirSync(hooks, { recursive: true })
  mkdirSync(pythonHooks, { recursive: true })
  copyFileSync(hook, join(hooks, 'pre-commit'))
  copyFileSync(pythonHook, join(pythonHooks, 'protect-main-checkout.py'))
  chmodSync(join(hooks, 'pre-commit'), 0o755)
  chmodSync(join(pythonHooks, 'protect-main-checkout.py'), 0o755)

  expect(git(repo, 'init', '-b', 'main').code).toBe(0)
  expect(git(repo, 'config', 'user.email', 'orch-test@example.invalid').code).toBe(0)
  expect(git(repo, 'config', 'user.name', 'Orch Test').code).toBe(0)
  expect(git(repo, 'config', 'core.hooksPath', '.githooks').code).toBe(0)

  const db = new Database(dbPath, { create: true })
  db.run('CREATE TABLE project (name TEXT NOT NULL, path TEXT NOT NULL, settings TEXT)')
  if (options.registered !== false) {
    db.run(
      'INSERT INTO project (name, path, settings) VALUES (?, ?, ?)',
      ['fixture', repo, JSON.stringify({ requireCleanMain: options.requireCleanMain })],
    )
  }
  db.close()
  return { dir, repo, dbPath }
}

function commit(repo: string, dbPath: string, message = 'fixture') {
  writeFileSync(join(repo, `${message}.txt`), `${message}\n`)
  expect(git(repo, 'add', '.').code).toBe(0)
  const result = Bun.spawnSync(['git', 'commit', '-m', message], {
    cwd: repo,
    env: {
      ...gitEnv,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      ORCH_DB: dbPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

test('refuses a commit in a registered main checkout with the three-line remedy', () => {
  const { repo, dbPath } = fixture()
  const result = commit(repo, dbPath)
  expect(result.code).not.toBe(0)
  expect(result.stderr.trim().split('\n')).toEqual([
    `fixture: refusing commit in registered main checkout ${repo}`,
    'invariant: A registered main checkout stays clean; work happens in a worktree',
    `cleared by: commit from a worktree under ${repo}/.claude/worktrees`,
  ])
})

test('allows a commit in a linked worktree of the registered checkout', () => {
  const { repo, dbPath, dir } = fixture()
  expect(git(repo, 'commit', '--no-verify', '--allow-empty', '-m', 'base').code).toBe(0)
  const tree = join(dir, 'tree')
  expect(git(repo, 'worktree', 'add', '-b', 'fixture-tree', tree, 'main').code).toBe(0)
  expect(commit(tree, dbPath, 'linked').code).toBe(0)
})

test('allows a commit in an unregistered repository', () => {
  const { repo, dbPath } = fixture({ registered: false })
  expect(commit(repo, dbPath).code).toBe(0)
})

test('allows a commit when requireCleanMain is false', () => {
  const { repo, dbPath } = fixture({ requireCleanMain: false })
  expect(commit(repo, dbPath).code).toBe(0)
})

test('fails open when the register is unreadable', () => {
  const { repo, dir } = fixture()
  const result = commit(repo, dir)
  expect(result.code).toBe(0)
})
