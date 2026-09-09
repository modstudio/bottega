import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENTS, addRun, contentTree, createReadOnlyWorktree, createWorktree, db, declaredCreate, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, prepareSharedRefGuard, prepareWorktreeObjects, runJob, score, upsertProject, worktreeGitDir } from '../test/fixture.ts'
const worktreeMod = await import('./worktree.ts')

describe('sweep only reclaims old orch-owned orphan worktrees', () => {
  const CLI = new URL('cli.ts', import.meta.url).pathname
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

  test('reports absent Grok trust paths in both heading quote styles without editing the store', () => {
    const grokHome = mkdtempSync(join(tmpdir(), 'orch-sweep-grok-home-'))
    const fake = fakeDocker([], [])
    const doubleHeading = `[folders."${join(grokHome, 'absent-double')}"]`
    const singleHeading = `[folders.'${join(grokHome, 'absent-single')}']`
    const store = `${doubleHeading}\ntrusted = true\n${singleHeading}\ntrusted = true\n`
    writeFileSync(join(grokHome, 'trusted_folders.toml'), store)
    const known = addRun({ agent: 'grok', job: 'review-lens' })
    db().query('UPDATE run SET mcp_trust_path=? WHERE id=?')
      .run(JSON.stringify([doubleHeading]), known)
    try {
      const result = orchWithEnv({ ...fake.env, GROK_HOME: grokHome }, 'sweep', '--dry-run')
      expect(result.code).toBe(0)
      expect(result.out).toContain(
        `grok trust entry for absent path ${join(grokHome, 'absent-double')} (run ${known}); prune by hand`,
      )
      expect(result.out).toContain(
        `grok trust entry for absent path ${join(grokHome, 'absent-single')}; prune by hand`,
      )
      expect(readFileSync(join(grokHome, 'trusted_folders.toml'), 'utf8')).toBe(store)
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
      rmSync(grokHome, { recursive: true, force: true })
    }
  })

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

  test('an unrecognised orphan is kept even with force', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'reader')
    try {
      git(repo, 'worktree', 'add', '-b', 'reader', tree, 'main')
      const r = orch('sweep', '--force')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  kept: not created by orch`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('recent filesystem activity does not keep an orch-named orphan', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'orch-900')
    try {
      git(repo, 'worktree', 'add', '-b', 'orch/900', tree, 'main')
      const r = orch('sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

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

  test('a live named chain with a lost worktree pointer is kept and named live', () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    try {
      git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')

      const r = orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  live — kept`)
      expect(r.out).not.toContain(`reclaimed orphan  ${tree}`)
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

  test("a foreign project's colliding run id does not keep a local orphan", () => {
    const repo = scratchRepo()
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: 'foreign-project',
      startedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
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

  test('an orphan does not use commit or reflog age as retention', () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'reflog-worker')
    const fake = ageGit('reflog', Math.floor((Date.now() - 2 * 86_400_000) / 1000))
    try {
      git(repo, 'worktree', 'add', '-b', 'reflog-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `997\n${repo}\n`)
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

  test("a successful project remove command's warning is attributed", () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      ageHead(repo, 2)
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `903\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      ageWorktree(tree)
      upsertProject({
        name, path: repo,
        settings: {
          trunk: 'main',
          worktree: {
            remove:
              "echo 'retained fixture resource' >&2; " +
              `${hermeticGitCommand} worktree remove --force {path}; ` +
              `${hermeticGitCommand} branch -D {branch}`,
          },
        },
      })

      const r = orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${name} remove:`)
      expect(r.out).toContain('retained fixture resource')
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

  test('a project sweep refusal is attributed and makes sweep fail', () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const sentinel = join(repo, 'project-resource')
    upsertProject({
      name, path: repo,
      settings: {
        trunk: 'main',
        worktree: { sweep: `printf retained > "${sentinel}"; echo 'database remains' >&2; exit 7` },
      },
    })
    try {
      const r = orch('sweep')
      expect(r.code).not.toBe(0)
      expect(readFileSync(sentinel, 'utf8')).toBe('retained')
      expect(r.out).toContain(`${name} sweep:`)
      expect(r.out).toContain('database remains')
      expect(r.err).toContain(`project ${name} sweep failed with exit status 7`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('sweep does not classify infrastructure for a running run as orphaned', () => {
    const project = `live-resource-${randomUUID()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const docker = fakeDocker([`orch-${id}-booting`], [])
    try {
      const r = orchWithEnv(docker.env, 'sweep')
      expect(r.code).toBe(0)
      expect(r.err).not.toContain(`orch-${id}-booting`)
      expect(r.err).not.toContain('leaked Docker resources')

      const doctor = Bun.spawnSync([process.execPath, CLI, 'doctor'], {
        env: {
          ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!,
          ORCH_DEPTH: '0', ORCH_LOCAL_BASE_URL: '',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(doctor.exitCode).toBe(0)
      expect(doctor.stdout.toString()).not.toContain(`orch-${id}-booting`)
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep exits non-zero and keeps the pointer when project removal is refused', () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    score(id, 'full', 'right')
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')
    upsertProject({
      name: project, path: repo,
      settings: { trunk: 'main', worktree: { remove: "echo 'protected work' >&2; exit 7" } },
    })
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(tree, `orch/${id}`, `orch/${id}`, git(repo, 'rev-parse', 'main'), id)
    try {
      ageWorktree(tree)
      const r = orch('sweep', '--force')
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(`could not reclaim ${id}`)
      expect(r.err).toContain('protected work')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('sweep reports unavailable Docker inventory after releasing the tree', () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    score(id, 'full', 'right')
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')
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
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(tree, `orch/${id}`, `orch/${id}`, git(repo, 'rev-parse', 'main'), id)
    const docker = fakeDockerCommand("echo 'stub inventory failure' >&2; exit 127")
    try {
      ageWorktree(tree)
      const r = orchWithEnv(docker.env, 'sweep', '--force')
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('inventory unavailable: 1')
      expect(r.err).toContain('stub inventory failure')
      expect(r.err).not.toContain('leaked Docker resources: 0')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep reports resources left by a project remove in its summary', () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    score(id, 'full', 'right')
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')
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
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(tree, `orch/${id}`, `orch/${id}`, git(repo, 'rev-parse', 'main'), id)
    const docker = fakeDocker([], [`orch-${id}_${project}-pgdata`])
    try {
      ageWorktree(tree)
      const r = orchWithEnv(docker.env, 'sweep', '--force')
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('leaked Docker resources: 1')
      expect(r.err).toContain(`volume orch-${id}_${project}-pgdata leaked by project ${project}`)
      expect(r.out).toContain('reclaimed 0, kept 1')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep dry-run retains containers and volumes without a recorded worktree', () => {
    const project = `dry-run-leak-${randomUUID()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const docker = fakeDocker(
      [`orch-${id}-postgres-1`],
      [`orch-${id}_${project}-pgdata`],
    )
    try {
      const r = orchWithEnv(docker.env, 'sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.err).toContain('would report retained worktree Docker resources: 2')
      expect(r.err).toContain(
        `container orch-${id}-postgres-1 re-served or retained by project ${project} (run ${id}); removal could not be ascertained: no recorded worktree`,
      )
      expect(r.err).toContain(
        `volume orch-${id}_${project}-pgdata re-served or retained by project ${project} (run ${id}); removal could not be ascertained: no recorded worktree`,
      )
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep and doctor report terminal resources in a retained tree without removal commands', () => {
    const project = `retained-resource-${randomUUID()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const tree = mkdtempSync(join(tmpdir(), `orch-${id}-retained-`))
    expect(Bun.spawnSync(['git', 'init', '-q', tree]).exitCode).toBe(0)
    db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, id)
    const noTree = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project,
      parent: noTree, turn: 2 })
    const goneTree = addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(join(tree, 'gone'), goneTree)
    const sharedTree = mkdtempSync(join(tmpdir(), `orch-${id}-shared-`))
    expect(Bun.spawnSync(['git', 'init', '-q', sharedTree]).exitCode).toBe(0)
    const terminalSharer = addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project })
    const liveSharer = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(sharedTree, terminalSharer)
    db().query('UPDATE run SET worktree=? WHERE id=?').run(`${sharedTree}/`, liveSharer)
    const docker = fakeDocker([
      `orch-${id}-web`, `orch-${noTree}-web`, `orch-${goneTree}-web`, `orch-${terminalSharer}-web`,
    ], [`orch-${id}_${project}-pgdata`])
    try {
      const sweep = orchWithEnv(docker.env, 'sweep', '--dry-run')
      expect(sweep.code).toBe(0)
      expect(sweep.err).toContain('retained worktree Docker resources: 5')
      expect(sweep.err).toContain('removal could not be ascertained: no recorded worktree')
      expect(sweep.err).toContain('removal could not be ascertained: unresolvable repository root')
      expect(sweep.err).toContain('removal could not be ascertained: live sharer present')
      expect(sweep.err).toContain('no removal suggested')
      expect(sweep.err).not.toContain('docker rm')

      const observed = orchWithEnv(docker.env, 'monitor')
      expect(observed.out).toContain('retained-worktree-docker-resource')
      expect(observed.out).toContain('removal could not be ascertained: no recorded worktree')
      expect(observed.out).toContain('removal could not be ascertained: unresolvable repository root')
      expect(observed.out).toContain('removal could not be ascertained: live sharer present')

      const doctor = Bun.spawnSync([process.execPath, CLI, 'doctor'], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(doctor.exitCode).toBe(0)
      expect(doctor.stdout.toString()).toContain('docker retained worktree resources  5')
      expect(doctor.stdout.toString()).toContain('removal could not be ascertained: no recorded worktree')
      expect(doctor.stdout.toString()).toContain('removal could not be ascertained: unresolvable repository root')
      expect(doctor.stdout.toString()).toContain('removal could not be ascertained: live sharer present')
      expect(doctor.stdout.toString()).toContain('informational, no removal suggested')
      expect(doctor.stdout.toString()).not.toContain(`docker rm -f orch-${id}-web`)
    } finally {
      rmSync(tree, { recursive: true, force: true })
      rmSync(sharedTree, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('an aged no-verdict void with an absent tree is released without an evidence guard', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const id = addRun({ agent: 'codex', job: 'understand', status: 'ok', startedAt: old })
    db().query("UPDATE run SET worktree=?, evidence_excluded=? WHERE id=?")
      .run(`/tmp/dev364-void-${id}`, 'voided with orch score --void', id)

    const r = orch('sweep', '--dry-run')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`would reclaim ${id}  /tmp/dev364-void-${id}`)
    expect(r.out).toContain('would reclaim 1, kept 0')
    expect(r.out).not.toContain('unscored — its diff is the evidence')
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

  test('terminal sharers do not block sweep regardless of scoring or void state', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const tree = '/tmp/dev364-shared-tree'
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', startedAt: old })
    score(target, 'full', 'right')
    const voided = addRun({ agent: 'codex', job: 'understand', status: 'ok', startedAt: old })
    const unscored = addRun({ agent: 'codex', job: 'implement', status: 'failed', startedAt: old })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, target)
    db().query("UPDATE run SET worktree=?, evidence_excluded=? WHERE id=?")
      .run(tree, 'voided with orch score --void', voided)
    db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, unscored)

    const released = orch('sweep', '--dry-run')
    expect(released.code).toBe(0)
    expect(released.out).toContain(`would reclaim ${target}  ${tree}`)
    expect(released.out).toContain(`would reclaim ${voided}  ${tree}`)
    expect(released.out).toContain(`would reclaim ${unscored}  ${tree}`)
    expect(released.out).not.toContain('unscored')
    expect(released.out).not.toContain('shared with')
  })

  test('more than ten kept rows are summarised by reason; --dry-run lists every row', () => {
    const held: number[] = []
    for (let i = 0; i < 11; i++) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
      db().query('UPDATE run SET worktree=?, keep_tree=1 WHERE id=?').run(`/tmp/dev148-held-${i}`, id)
      held.push(id)
    }

    const summarised = orch('sweep')
    expect(summarised.code).toBe(0)
    expect(summarised.out).toContain('reclaimed 0, kept 11')
    expect(summarised.out).toContain('11  held by explicit --keep-tree; clear with orch discard <run-id>')
    expect(summarised.out).toContain('orch sweep --dry-run lists every kept row')
    for (const id of held) expect(summarised.out).not.toContain(`${id}  held:`)

    const listed = orch('sweep', '--dry-run')
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('would reclaim 0, kept 11')
    expect(listed.out).toContain('11  held by explicit --keep-tree; clear with orch discard <run-id>')
    expect(listed.out).not.toContain('lists every kept row')
    for (const id of held) expect(listed.out).toContain(`${id}  held:`)
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

  test('a project sweep longer than eight lines says how many were omitted', () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const lines = Array.from({ length: 10 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
    upsertProject({
      name, path: repo,
      settings: {
        trunk: 'main',
        worktree: { sweep: `printf '%s\\n' ${lines.join(' ')}` },
      },
    })
    try {
      const r = orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${name} sweep:`)
      expect(r.out).toContain('L03')
      expect(r.out).toContain('L10')
      expect(r.out).not.toContain('L01')
      expect(r.out).not.toContain('L02')
      expect(r.out).toContain('(2 earlier lines omitted)')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('content tree measurement', () => {
  test('keeps tracked ignored files, includes visible dirt, and measures tracked deletions', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-content-tree-'))
    const g = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      g('init', '-b', 'main')
      g('config', 'user.email', 'orch-test@example.invalid')
      g('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      writeFileSync(join(repo, 'secret.txt'), 'tracked secret\n')
      g('add', '.')
      g('commit', '-m', 'base')
      writeFileSync(join(repo, '.gitignore'), 'secret.txt\nignored.txt\n')
      g('add', '.gitignore')
      g('commit', '-m', 'ignore tracked secret later')
      expect(g('status', '--porcelain=v1')).toBe('')
      expect(contentTree(repo)).toBe(g('rev-parse', 'HEAD^{tree}'))

      const indexBefore = g('write-tree')
      rmSync(join(repo, 'tracked.txt'))
      writeFileSync(join(repo, 'visible.txt'), 'visible\n')
      writeFileSync(join(repo, 'ignored.txt'), 'ignored\n')
      const measured = contentTree(repo)
      expect(measured).not.toBe(g('rev-parse', 'HEAD^{tree}'))
      expect(g('write-tree')).toBe(indexBefore)
      expect(g('ls-tree', '-r', '--name-only', measured).split('\n')).toEqual([
        '.gitignore', 'secret.txt', 'visible.txt',
      ])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a measurement failure before vendor spawn is a harness failure with the git message', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-content-tree-failure-'))
    const g = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const agent = AGENTS.codex!
    const vendorMarker = join(repo, 'vendor-started')
    const original = { bin: agent.bin, argv: agent.argv, stdin: agent.stdin,
      readsOut: agent.readsOut, parseReply: agent.parseReply }
    const oldDepth = process.env.ORCH_DEPTH
    try {
      g('init', '-b', 'main')
      g('config', 'user.email', 'orch-test@example.invalid')
      g('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      g('add', '.')
      g('commit', '-m', 'base')
      agent.bin = process.execPath
      agent.argv = () => ['-e', `await Bun.write(${JSON.stringify(vendorMarker)}, 'started')`]
      agent.stdin = false
      agent.readsOut = false
      agent.parseReply = undefined
      process.env.ORCH_DEPTH = '0'
      const originalCreate = worktreeMod.createReadOnlyWorktree
      const createSpy = spyOn(worktreeMod, 'createReadOnlyWorktree').mockImplementation((...args) => {
        const created = originalCreate(...args)
        writeFileSync(join(worktreeGitDir(created.path), 'HEAD'),
          'ref: refs/heads/missing-measurement-head\n')
        return created
      })

      let runId: number | undefined
      try {
        await runJob({
          job: 'review-lens', prompt: 'measurement must fail', cwd: repo,
          agent: 'codex', lens: 'measurement-failure',
        })
      } catch (error) {
        runId = (error as Error & { runId?: number }).runId
      } finally {
        createSpy.mockRestore()
      }
      expect(runId).toBeNumber()
      const row = db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(runId!) as
        { status: string; failure_kind: string; error: string }
      expect(row.status).toBe('failed')
      expect(row.failure_kind).toBe('harness')
      expect(row.error).toContain('git read-tree HEAD failed while measuring content tree')
      expect(row.error).not.toContain('at contentTree')
      expect(existsSync(vendorMarker)).toBe(false)
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.stdin = original.stdin
      agent.readsOut = original.readsOut
      agent.parseReply = original.parseReply
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
