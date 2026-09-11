import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENTS, addRun, contentTree, createReadOnlyWorktree, createWorktree, db, declaredCreate, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, prepareSharedRefGuard, prepareWorktreeObjects, runJob, score, upsertProject, worktreeGitDir } from '../fixture.ts'
const worktreeMod = await import('../../src/worktree.ts')
describe('sweep only reclaims old orch-owned orphan worktrees', () => {
  const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
  const processInventoryBin = mkdtempSync(join(tmpdir(), 'orch-empty-process-inventory-'))
  writeFileSync(join(processInventoryBin, 'ps'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(processInventoryBin, 'ps'), 0o755)
  afterAll(() => rmSync(processInventoryBin, { recursive: true, force: true }))
  const orch = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: {
        ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        PATH: `${processInventoryBin}:${process.env.PATH ?? ''}`,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const orchWithEnv = (env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], {
      env: {
        ...process.env, ...env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        PATH: `${processInventoryBin}:${env.PATH ?? process.env.PATH ?? ''}`,
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    }
  }
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const gitWithEnv = (cwd: string, env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const ageHead = (repo: string, days: number) => {
    const date = new Date(Date.now() - days * 86_400_000).toISOString()
    gitWithEnv(
      repo, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      'commit', '--amend', '--no-edit', '--date', date,
    )
  }
  const ageWorktree = (tree: string, hours = 3) => {
    const old = new Date(Date.now() - hours * 60 * 60 * 1000)
    for (const name of git(tree, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
      utimesSync(join(tree, name), old, old)
    }
  }

  test('sweep removes a git-made read-only tree before running project sweep', () => {
    const repo = scratchRepo()
    const project = `readonly-sweep-${randomUUID()}`
    const removeSentinel = join(repo, 'remove-invoked')
    const sweepSentinel = join(repo, 'sweep-invoked')
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const id = addRun({ agent: 'codex', job: 'file-question', status: 'ok', repo: project, startedAt: old })
    const tree = createReadOnlyWorktree(repo, id, git(repo, 'rev-parse', 'HEAD'))
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch=NULL, base_commit=?, worktree_source='git' WHERE id=?`,
    ).run(tree.path, tree.path, tree.base, id)
    score(id, 'full', 'right')
    upsertProject({
      name: project, path: repo,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate('git', ['worktree', 'add', '-b', '{branch}', '{path}', '{base}']),
        remove: `printf invoked > "${removeSentinel}"`, branch: 'orch/{id}',
        sweep: `printf invoked > "${sweepSentinel}"`,
      } },
    })
    const docker = fakeDocker([], [])
    try {
      ageWorktree(tree.path)
      const result = orchWithEnv(docker.env, 'sweep')
      expect(result.code).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(existsSync(removeSentinel)).toBe(false)
      expect(readFileSync(sweepSentinel, 'utf8')).toBe('invoked')
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('project sweep reclaims a recipe orphan while leaving a kept plain tree untouched', () => {
    const repo = scratchRepo()
    const project = `readonly-orphan-${randomUUID()}`
    const removeSentinel = join(repo, 'remove-invoked')
    const sweepSentinel = join(repo, 'sweep-invoked')
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const id = addRun({ agent: 'codex', job: 'file-question', status: 'ok', repo: project, startedAt: old })
    const kept = createReadOnlyWorktree(repo, id, git(repo, 'rev-parse', 'HEAD'))
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch=NULL, base_commit=?, worktree_source='git', keep_tree=1 WHERE id=?`,
    ).run(kept.path, kept.path, kept.base, id)
    const recipeOrphan = join(repo, '.claude', 'worktrees', 'recipe-orphan')
    git(repo, 'worktree', 'add', '--detach', recipeOrphan, 'HEAD')
    upsertProject({
      name: project, path: repo,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate('git', ['worktree', 'add', '-b', '{branch}', '{path}', '{base}']),
        remove: `printf invoked > "${removeSentinel}"`, branch: 'orch/{id}',
        sweep: `test -f "${join(kept.path, '.orch-run')}" && ` +
          `${hermeticGitCommand} worktree remove --force "${recipeOrphan}" && ` +
          `printf invoked > "${sweepSentinel}"`,
      } },
    })
    const docker = fakeDocker([], [])
    try {
      expect(readFileSync(join(kept.path, '.orch-run'), 'utf8')).toContain('source: git')
      const result = orchWithEnv(docker.env, 'sweep')
      expect(result.code).toBe(0)
      expect(existsSync(kept.path)).toBe(true)
      expect(existsSync(recipeOrphan)).toBe(false)
      expect(existsSync(removeSentinel)).toBe(false)
      expect(readFileSync(sweepSentinel, 'utf8')).toBe('invoked')
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })
  const ageGit = (mode: 'reflog' | 'unknown' | 'detached', reflogSeconds = 0) => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-age-git-'))
    const script = join(dir, 'git')
    const actualGit = Bun.which('git')!
    writeFileSync(script, `#!/bin/sh
if [ "$1" = "log" ] && [ "${mode}" != "detached" ]; then exit 1; fi
if [ "$1" = "symbolic-ref" ] && [ "${mode}" = "unknown" ]; then exit 1; fi
if [ "$1" = "reflog" ]; then printf '%s\\n' "branch@{${reflogSeconds}}"; exit 0; fi
exec ${JSON.stringify(actualGit)} "$@"
`)
    chmodSync(script, 0o755)
    return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }
  }
  const scratchRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-sweep-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'base')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    upsertProject({ name: `sweep-${repo.split('/').pop()}`, path: repo, settings: { trunk: 'main' } })
    return repo
  }

  test('a terminal named chain without a worktree pointer is reclaimed as an orphan', () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const root = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project,
      startedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project, parent: root, turn: 2,
      startedAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    })
    const name = `DEV-298-orch-${root}`
    const tree = join(repo, '.claude', 'worktrees', name)
    upsertProject({
      name: project, path: repo,
      settings: { trunk: 'main', worktree: { branch: '{key}-orch-{id}' } },
    })
    try {
      git(repo, 'worktree', 'add', '-b', name, tree, 'main')
      const r = orch('sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a terminal named chain with a lost worktree pointer is reclaimed', () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    db().query('UPDATE run SET latency_ms=NULL WHERE id=?').run(id)
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    try {
      git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')

      const r = orch('sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a marked orphan is reclaimed regardless of reflog age', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'fresh-reflog-worker')
    try {
      ageHead(repo, 2)
      git(repo, 'worktree', 'add', '-b', 'fresh-reflog-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `996\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')

      const r = orch('sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a clean detached orphan is reclaimed', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'detached-worker')
    const fake = ageGit('detached', Math.floor((Date.now() - 2 * 86_400_000) / 1000))
    try {
      ageHead(repo, 3)
      git(repo, 'worktree', 'add', '--detach', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `995\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')

      const r = orchWithEnv(fake.env, 'sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an orphan with unreadable git age is reclaimed', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'unknown-worker')
    const fake = ageGit('unknown')
    try {
      git(repo, 'worktree', 'add', '-b', 'unknown-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `998\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')

      const r = orchWithEnv(fake.env, 'sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an old marked orphan is reclaimed', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      ageHead(repo, 2)
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `901\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      ageWorktree(tree)

      const r = orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('sweep preserves its branch when a project remover deletes it', () => {
    const repo = scratchRepo()
    const workerRepo = scratchRepo()
    const worker = createWorktree(workerRepo, 1702)
    const managedEnv = {
      ...prepareWorktreeObjects(worker.path),
      ...prepareSharedRefGuard(worker.path, `refs/heads/${worker.branch}`),
    }
    const project = `sweep-${repo.split('/').pop()}`
    const old = new Date(Date.now() - 86_400_000).toISOString()
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project, startedAt: old,
    })
    score(id, 'full', 'right')
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const branch = `orch/${id}`
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', branch, tree, 'main')
    upsertProject({
      name: project, path: repo,
      settings: {
        trunk: 'main',
        worktree: {
          remove: `${hermeticGitCommand} worktree remove --force {path}; ` +
            `${hermeticGitCommand} branch -D {branch}`,
        },
      },
    })
    db().query(
      `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(repo, tree, branch, branch, git(repo, 'rev-parse', 'main'), id)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, branch, owner)
    try {
      ageWorktree(tree)
      const r = orchWithEnv(managedEnv, 'sweep', '--force')
      expect(r.code).toBe(0)
      expect(r.err).not.toContain(`project remove tool deleted shared branch ${branch}`)
      expect(git(repo, 'rev-parse', branch)).toBe(git(repo, 'rev-parse', 'main'))
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(workerRepo, { recursive: true, force: true })
    }
  })

  test('an unscored terminal run is reclaimed when its tree is already absent', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const id = addRun({ agent: 'codex', job: 'understand', status: 'ok', startedAt: old })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(`/tmp/dev364-unscored-${id}`, id)

    const r = orch('sweep', '--dry-run')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`would reclaim ${id}  /tmp/dev364-unscored-${id}`)
    expect(r.out).toContain('would reclaim 1, kept 0')
    expect(r.out).not.toContain('unscored — its diff is the evidence')
  })

  test('a clean marked orphan is reclaimed without a configured trunk', () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    upsertProject({ name, path: repo, settings: {} })
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      ageHead(repo, 2)
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `902\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      ageWorktree(tree)

      const r = orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
