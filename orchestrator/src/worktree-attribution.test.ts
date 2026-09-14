import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { createWorktree, removeFor } from './worktree.ts'
import {
  extractWorktree, extractionDest, sanitiseOrphanExtractionPath,
} from './worktree-attribution.ts'
import { reclaimWorktree } from './reclaim.ts'

const repos: string[] = []

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

function scratchRepo(): { repo: string; project: string } {
  const repo = cloneRepository('orch-extract-')
  repos.push(repo)
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
  const project = `extract-${randomUUID()}`
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main' } })
  return { repo, project }
}

function rememberedTree(status = 'ok') {
  const { repo, project } = scratchRepo()
  const id = addRun({ agent: 'codex', job: 'implement', status, repo: project })
  const tree = createWorktree(repo, id)
  db().query(
    `UPDATE run SET repo=?, cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source='git'
      WHERE id=?`,
  ).run(project, tree.path, tree.path, tree.branch, tree.branch, tree.base, id)
  return { repo, project, id, tree }
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

test('a clean tree writes only extraction.json with ok:true', () => {
  const f = rememberedTree()
  const extracted = extractWorktree(f.tree.path, f.id)
  expect(extracted.ok).toBe(true)
  if (!extracted.ok) return
  expect(extracted.dest).toBe(join(process.env.ORCH_RUNS!, String(f.id), 'artifacts'))
  expect(existsSync(join(extracted.dest, 'uncommitted.patch'))).toBe(false)
  expect(existsSync(join(extracted.dest, 'untracked'))).toBe(false)
  expect(JSON.parse(readFileSync(join(extracted.dest, 'extraction.json'), 'utf8'))).toMatchObject({
    runId: f.id, tree: f.tree.path, ok: true, trackedBytes: 0, untrackedCount: 0,
    branch: f.tree.branch,
  })
})

test('trackedBytes is the byte length of uncommitted.patch', () => {
  const f = rememberedTree()
  writeFileSync(join(f.tree.path, 'base.txt'), 'changed\n')
  const extracted = extractWorktree(f.tree.path, f.id)
  expect(extracted.ok).toBe(true)
  if (!extracted.ok) return
  const patch = readFileSync(join(extracted.dest, 'uncommitted.patch'))
  expect(extracted.record.trackedBytes).toBe(patch.byteLength)
  expect(extracted.record.trackedBytes).toBeGreaterThan(0)
  expect(extracted.record.untrackedCount).toBe(0)
})

test('untracked files are copied under untracked/ preserving relative paths', () => {
  const f = rememberedTree()
  mkdirSync(join(f.tree.path, 'nested'), { recursive: true })
  writeFileSync(join(f.tree.path, 'nested', 'new.txt'), 'new\n')
  const extracted = extractWorktree(f.tree.path, f.id)
  expect(extracted.ok).toBe(true)
  if (!extracted.ok) return
  expect(extracted.record.untrackedCount).toBe(1)
  expect(readFileSync(join(extracted.dest, 'untracked', 'nested', 'new.txt'), 'utf8')).toBe('new\n')
  expect(existsSync(join(extracted.dest, 'uncommitted.patch'))).toBe(false)
})

test('extraction failure names the step and leave the tree', () => {
  const junk = mkdtempSync(join(tmpdir(), 'orch-not-git-'))
  try {
    writeFileSync(join(junk, 'x.txt'), 'x\n')
    const extracted = extractWorktree(junk, null)
    expect(extracted.ok).toBe(false)
    if (extracted.ok) return
    expect(extracted.detail).toContain('extraction failed at git rev-parse HEAD')
    expect(existsSync(junk)).toBe(true)
    const { repo } = scratchRepo()
    const removed = removeFor({ path: junk, branch: '', base: '', repoRoot: repo }, repo)
    expect(removed.removed).toBe(false)
    expect(removed.detail).toContain('extraction failed at git rev-parse HEAD')
    expect(existsSync(junk)).toBe(true)
  } finally {
    rmSync(junk, { recursive: true, force: true })
  }
})

test('an unknown run id writes under runs/orphans with runId null', () => {
  const { repo } = scratchRepo()
  const tree = join(repo, '.claude', 'worktrees', 'orphan-extract')
  git(repo, 'worktree', 'add', '-b', 'orphan-extract', tree, 'main')
  const extracted = extractWorktree(tree, 999_999_999)
  expect(extracted.ok).toBe(true)
  if (!extracted.ok) return
  expect(extracted.record.runId).toBe(null)
  expect(extracted.dest).toBe(join(
    process.env.ORCH_RUNS!, 'orphans', sanitiseOrphanExtractionPath(tree),
  ))
  expect(extracted.dest).toBe(extractionDest(tree, 999_999_999))
})

test('removeFor extracts then removes a dirty remembered tree', () => {
  const f = rememberedTree()
  writeFileSync(join(f.tree.path, 'new.txt'), 'new\n')
  const removed = removeFor(f.tree, f.repo, false, true, f.id)
  expect(removed.removed).toBe(true)
  expect(existsSync(f.tree.path)).toBe(false)
  const record = JSON.parse(readFileSync(
    join(process.env.ORCH_RUNS!, String(f.id), 'artifacts', 'extraction.json'), 'utf8',
  )) as { ok: boolean; untrackedCount: number }
  expect(record.ok).toBe(true)
  expect(record.untrackedCount).toBe(1)
})

test('reclaim succeeds on a tree with no run row and keeps unique commits', () => {
  const { repo } = scratchRepo()
  const tree = join(repo, '.claude', 'worktrees', 'unique-orphan')
  git(repo, 'worktree', 'add', '-b', 'unique-orphan', tree, 'main')
  writeFileSync(join(tree, 'unique.txt'), 'unique\n')
  git(tree, 'add', 'unique.txt')
  git(tree, 'commit', '-m', 'unique')
  writeFileSync(join(tree, 'dirty.txt'), 'dirty\n')
  const tip = git(tree, 'rev-parse', 'HEAD')
  const dest = extractionDest(realpathSync(tree), null)
  const result = reclaimWorktree(tree)
  expect(result.ok, result.action).toBe(true)
  expect(existsSync(tree)).toBe(false)
  expect(git(repo, 'rev-parse', 'unique-orphan')).toBe(tip)
  const record = JSON.parse(readFileSync(join(dest, 'extraction.json'), 'utf8')) as {
    runId: number | null; ok: boolean; untrackedCount: number
  }
  expect(record.runId).toBe(null)
  expect(record.ok).toBe(true)
  expect(record.untrackedCount).toBe(1)
})

test('reclaim of an orphan whose commits are on trunk deletes the branch', () => {
  const { repo } = scratchRepo()
  const tree = join(repo, '.claude', 'worktrees', 'reachable-orphan')
  git(repo, 'worktree', 'add', '-b', 'reachable-orphan', tree, 'main')
  writeFileSync(join(tree, 'dirty.txt'), 'dirty\n')
  const result = reclaimWorktree(tree)
  expect(result.ok, result.action).toBe(true)
  expect(existsSync(tree)).toBe(false)
  expect(git(repo, 'branch', '--list', 'reachable-orphan')).toBe('')
})
