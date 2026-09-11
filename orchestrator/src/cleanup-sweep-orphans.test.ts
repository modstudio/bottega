import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENTS, addRun, contentTree, createReadOnlyWorktree, createWorktree, db, declaredCreate, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, prepareSharedRefGuard, prepareWorktreeObjects, runJob, score, upsertProject, worktreeGitDir } from '../test/fixture.ts'
import { runSweep } from '../test/fake-sweep.ts'
const worktreeMod = await import('./worktree.ts')
describe('sweep only reclaims old orch-owned orphan worktrees', () => {
  const processInventoryBin = mkdtempSync(join(tmpdir(), 'orch-empty-process-inventory-'))
  writeFileSync(join(processInventoryBin, 'ps'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(processInventoryBin, 'ps'), 0o755)
  afterAll(() => rmSync(processInventoryBin, { recursive: true, force: true }))
  const orch = (...args: string[]) => runSweep({
    PATH: `${processInventoryBin}:${process.env.PATH ?? ''}`,
  }, ...args)
  const orchWithEnv = (env: Record<string, string>, ...args: string[]) => runSweep({
    ...env, PATH: `${processInventoryBin}:${env.PATH ?? process.env.PATH ?? ''}`,
  }, ...args)
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

  test('reports absent Grok trust paths in both heading quote styles without editing the store', async () => {
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
      const result = await orchWithEnv({ ...fake.env, GROK_HOME: grokHome }, 'sweep', '--dry-run')
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

  test('an unrecognised orphan is kept even with force', async () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'reader')
    try {
      git(repo, 'worktree', 'add', '-b', 'reader', tree, 'main')
      const r = await orch('sweep', '--force')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  kept: not created by orch`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('recent filesystem activity does not keep an orch-named orphan', async () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'orch-900')
    try {
      git(repo, 'worktree', 'add', '-b', 'orch/900', tree, 'main')
      const r = await orch('sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a live named chain with a lost worktree pointer is kept and named live', async () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    try {
      git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')

      const r = await orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`orphan  ${tree}  live — kept`)
      expect(r.out).not.toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("a foreign project's colliding run id does not keep a local orphan", async () => {
    const repo = scratchRepo()
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: 'foreign-project',
      startedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    try {
      git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')

      const r = await orch('sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an orphan does not use commit or reflog age as retention', async () => {
    const repo = scratchRepo()
    const tree = join(repo, '.claude', 'worktrees', 'reflog-worker')
    const fake = ageGit('reflog', Math.floor((Date.now() - 2 * 86_400_000) / 1000))
    try {
      git(repo, 'worktree', 'add', '-b', 'reflog-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `997\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')

      const r = await orchWithEnv(fake.env, 'sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`would reclaim orphan  ${tree}`)
      expect(existsSync(tree)).toBe(true)
    } finally {
      rmSync(fake.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
