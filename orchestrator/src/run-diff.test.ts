// Tests run-diff.ts: runDiffCommand.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { addRun, dir } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { prepareWorktreeObjects } from './git-environment.ts'
import { upsertProject } from './projects.ts'
import { changesIn, createWorktree } from './worktree.ts'
import { runDiffCommand } from './run-diff.ts'

async function showRunDiff(
  id: number,
  repoRoot: string,
  extra: string[] = [],
  foreignObjects?: string,
): Promise<{ exitCode: number; stdout: Buffer }> {
  let output = ''
  const priorObjects = process.env.GIT_OBJECT_DIRECTORY
  const priorAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  try {
    if (foreignObjects) {
      process.env.GIT_OBJECT_DIRECTORY = foreignObjects
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = foreignObjects
    }
    await runDiffCommand(id, { has: (name) => extra.includes(`--${name}`) }, {
      error: () => {},
      write: (value) => { output += value },
      usage: (): never => { throw new Error('usage') },
      cleanupRepoRoot: () => repoRoot,
      changesIn,
      writesRepo: () => true,
    })
  } finally {
    if (priorObjects === undefined) delete process.env.GIT_OBJECT_DIRECTORY
    else process.env.GIT_OBJECT_DIRECTORY = priorObjects
    if (priorAlternates === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = priorAlternates
  }
  return { exitCode: 0, stdout: Buffer.from(output) }
}

test('diff surfaces the recorded base commit', async () => {
  const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, env: hermeticGitEnv(), stdout: 'pipe' }).stdout.toString().trim()
  const id = addRun({ agent: 'codex', job: 'implement' })
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=? WHERE id=?').run(dir, dir, 'fixture', base, id)
  const writes: string[] = []; const errors: string[] = []
  await runDiffCommand(id, { has: () => false }, {
    error: (...values) => errors.push(values.join(' ')), write: (value) => writes.push(value),
    usage: (): never => { throw new Error('usage') }, cleanupRepoRoot: () => dir,
    changesIn: () => ({ diff: '', files: [], insertions: 0, deletions: 0,
      since: base, trunk: 'main', trunkConfigured: false }), writesRepo: () => true,
  })
  expect(writes.join('')).toContain(`base: ${base} (recorded)`)
  expect(errors.join('\n')).toContain(`base:     ${base}`)
})

  test('orch diff resolves a new blob staged in the worker-local object database', async () => {
    const repo = cloneRepository('orch-isolated-objects-')
    const foreignObjects = mkdtempSync(join(tmpdir(), 'orch-foreign-objects-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, ['add', 'kept.txt'])
      git(repo, ['commit', '-m', 'base'])
      const tree = createWorktree(repo, 126)
      const objectEnv = prepareWorktreeObjects(tree.path)
      const content = `worker-only-${randomUUID()}\n`
      writeFileSync(join(tree.path, 'new.txt'), content)
      git(tree.path, ['add', 'new.txt'], objectEnv)
      const oid = git(tree.path, ['hash-object', 'new.txt'], objectEnv)

      expect(existsSync(join(objectEnv.GIT_OBJECT_DIRECTORY, oid.slice(0, 2), oid.slice(2))))
        .toBe(true)
      expect(existsSync(join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2))))
        .toBe(false)

      const id = addRun({ agent: 'codex', job: 'implement' })
      db().query('UPDATE run SET worktree=?, branch=?, base_commit=? WHERE id=?')
        .run(tree.path, tree.branch, tree.base, id)
      const diff = await showRunDiff(id, repo, [], foreignObjects)

      expect(diff.exitCode).toBe(0)
      expect(diff.stdout.toString()).toContain('diff --git a/new.txt b/new.txt')
      expect(diff.stdout.toString()).toContain(`+${content.trim()}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignObjects, { recursive: true, force: true })
    }
  })

  test('orch diff anchors at current trunk and --since-base restores the recorded range', async () => {
    const repo = cloneRepository('orch-diff-trunk-')
    const foreignObjects = mkdtempSync(join(tmpdir(), 'orch-foreign-objects-'))
    const worker = join(repo, 'worker')
    const g = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      const recorded = g(repo, 'rev-parse', 'HEAD')
      for (const name of ['trunk-one', 'trunk-two']) {
        writeFileSync(join(repo, `${name}.txt`), `${name}\n`)
        g(repo, 'add', `${name}.txt`)
        g(repo, 'commit', '-m', name)
      }
      const trunk = g(repo, 'rev-parse', 'HEAD')
      g(repo, 'worktree', 'add', '-b', 'DEV-283-worker', worker, 'main')
      writeFileSync(join(worker, 'worker.txt'), 'worker\n')
      g(worker, 'add', 'worker.txt')
      g(worker, 'commit', '-m', 'DEV-283 worker change')
      const head = g(worker, 'rev-parse', 'HEAD')
      const tree = g(worker, 'rev-parse', 'HEAD^{tree}')
      const project = `diff-trunk-${randomUUID()}`
      upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
      const id = addRun({ agent: 'codex', job: 'implement', repo: project })
      db().query(
        'UPDATE run SET worktree=?, branch=?, base_commit=?, input_tree=?, head_commit=? WHERE id=?',
      ).run(worker, 'DEV-283-worker', recorded, tree, head, id)
      const show = (...extra: string[]) => showRunDiff(id, repo, ['--quiet', ...extra], foreignObjects)

      const current = await show()
      expect(current.exitCode).toBe(0)
      const currentText = current.stdout.toString()
      expect(currentText).toContain(`base: ${recorded} (recorded)`)
      expect(currentText).toContain(`since: ${trunk} (trunk main)`)
      expect(currentText).toContain('DEV-283 worker change')
      expect(currentText).toContain('diff --git a/worker.txt b/worker.txt')
      expect(currentText).not.toContain('diff --git a/trunk-one.txt b/trunk-one.txt')
      expect(currentText).not.toContain('diff --git a/trunk-two.txt b/trunk-two.txt')

      const full = await show('--since-base')
      expect(full.exitCode).toBe(0)
      const fullText = full.stdout.toString()
      expect(fullText).toContain(`since: ${recorded} (recorded; --since-base)`)
      expect(fullText).toContain('DEV-283 worker change')
      expect(fullText).toContain('trunk-one')
      expect(fullText).toContain('trunk-two')
      expect(fullText).toContain('diff --git a/trunk-one.txt b/trunk-one.txt')
      expect(fullText).toContain('diff --git a/trunk-two.txt b/trunk-two.txt')

      g(repo, 'worktree', 'remove', '--force', worker)
      db().query('UPDATE run SET worktree=NULL, branch_kept=? WHERE id=?')
        .run('DEV-283-worker', id)
      const discarded = await show()
      expect(discarded.exitCode).toBe(0)
      const discardedText = discarded.stdout.toString()
      expect(discardedText).toContain(`since: ${trunk} (trunk main; worktree discarded)`)
      expect(discardedText).toContain('DEV-283 worker change')
      expect(discardedText).toContain('diff --git a/worker.txt b/worker.txt')
      expect(discardedText).not.toContain('diff --git a/trunk-one.txt b/trunk-one.txt')
      expect(discardedText).not.toContain('diff --git a/trunk-two.txt b/trunk-two.txt')

      const discardedFull = await show('--since-base')
      expect(discardedFull.exitCode).toBe(0)
      const discardedFullText = discardedFull.stdout.toString()
      expect(discardedFullText).toContain(
        `since: ${recorded} (recorded; --since-base; worktree discarded)`,
      )
      expect(discardedFullText).toContain('diff --git a/trunk-one.txt b/trunk-one.txt')
      expect(discardedFullText).toContain('diff --git a/trunk-two.txt b/trunk-two.txt')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignObjects, { recursive: true, force: true })
    }
  }, 20_000)

  test('orch diff finds an unregistered repository after its worktree is discarded', async () => {
    const repo = cloneRepository('orch-diff-unregistered-')
    const worker = join(repo, 'worker')
    const g = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      const recorded = g(repo, 'rev-parse', 'HEAD')
      writeFileSync(join(repo, 'trunk.txt'), 'trunk\n')
      g(repo, 'add', 'trunk.txt')
      g(repo, 'commit', '-m', 'trunk')
      const trunk = g(repo, 'rev-parse', 'HEAD')
      g(repo, 'worktree', 'add', '-b', 'DEV-283-unregistered', worker, 'main')
      writeFileSync(join(worker, 'worker.txt'), 'worker\n')
      g(worker, 'add', 'worker.txt')
      g(worker, 'commit', '-m', 'DEV-283 unregistered worker')
      g(repo, 'worktree', 'remove', '--force', worker)

      const id = addRun({ agent: 'codex', job: 'implement' })
      db().query(
        `UPDATE run SET cwd=?, worktree=NULL, branch=?, branch_kept=?, base_commit=?
          WHERE id=?`,
      ).run(repo, 'DEV-283-unregistered', 'DEV-283-unregistered', recorded, id)
      const shown = await showRunDiff(id, repo, ['--quiet'])

      expect(shown.exitCode).toBe(0)
      const output = shown.stdout.toString()
      expect(output).toContain(`since: ${trunk} (trunk main; worktree discarded)`)
      expect(output).toContain('diff --git a/worker.txt b/worker.txt')
      expect(output).not.toContain('diff --git a/trunk.txt b/trunk.txt')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
