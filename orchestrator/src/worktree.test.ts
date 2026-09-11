import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compoundCreate, createWithTool, createWorktree, declaredCreate, hermeticGitCommand, hermeticGitEnv, processStartTime, projectLockDir, reclaimStaleProjectLock, resolveBase, staleProjectLockHolder, withWorktreeCreateLock, worktreeDescribeFixture } from '../test/fixture.ts'

function repo() {
  const path = mkdtempSync(join(tmpdir(), 'orch-base-test-'))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-b', 'main'); git('config', 'user.email', 'orch-test@example.invalid'); git('config', 'user.name', 'Orch Test')
  writeFileSync(join(path, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base')
  return { path, git }
}

test("an implicit writing base is the caller's HEAD", () => {
  const fixture = repo()
  try {
    fixture.git('checkout', '-b', 'topic'); writeFileSync(join(fixture.path, 'topic.txt'), 'topic\n')
    fixture.git('add', '.'); fixture.git('commit', '-m', 'topic')
    expect(resolveBase(fixture.path, 'HEAD')).toBe(fixture.git('rev-parse', 'HEAD'))
  } finally { rmSync(fixture.path, { recursive: true, force: true }) }
})

test('fix --base creates its worktree at the requested commit', () => {
  const fixture = repo()
  try {
    const base = fixture.git('rev-parse', 'HEAD')
    writeFileSync(join(fixture.path, 'later.txt'), 'later\n'); fixture.git('add', '.'); fixture.git('commit', '-m', 'later')
    const tree = createWorktree(fixture.path, 987654, base)
    expect(tree.base).toBe(base)
    expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: tree.path, stdout: 'pipe' }).stdout.toString().trim()).toBe(base)
    if (existsSync(tree.path)) rmSync(tree.path, { recursive: true, force: true })
  } finally { rmSync(fixture.path, { recursive: true, force: true }) }
})
describe("worktree lifecycle decisions", () => {
  const { git, scratchRepo } = worktreeDescribeFixture()
test('project lock state resolves under the shared git common directory regardless of environment', () => {
  const { repo } = scratchRepo()
  const priorXdg = process.env.XDG_RUNTIME_DIR
  try {
    const xdg = mkdtempSync(join(tmpdir(), 'orch-xdg-'))
    const expected = realpathSync(join(repo, '.git'))
    expect(projectLockDir(repo)).toBe(join(expected, 'orch', 'locks'))
    process.env.XDG_RUNTIME_DIR = xdg
    expect(projectLockDir(repo)).toBe(join(expected, 'orch', 'locks'))
    const linked=join(repo,'linked-runtime-key');git(repo,'worktree','add','-b','runtime-key',linked,'HEAD')
    expect(projectLockDir(linked)).toBe(projectLockDir(repo))
  } finally {
    if (priorXdg === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = priorXdg
    rmSync(repo, { recursive: true, force: true })
  }
})

  test('legacy checkout lock and waiter directories are neither adopted nor removed', () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-create.lock')
    const waiters = join(repo, 'orch-create.waiters')
    try {
      mkdirSync(lock)
      mkdirSync(waiters)
      expect(() => withWorktreeCreateLock(repo, () => 'created', 20)).toThrow('timed out')
      expect(existsSync(lock)).toBe(true)
      expect(existsSync(waiters)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an uncontended creation lock still runs the critical section', () => {
    const { repo } = scratchRepo()
    try {
      expect(withWorktreeCreateLock(repo, () => 'created')).toBe('created')
      expect(existsSync(join(repo, '.git', 'orch-create.lock'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a null recorded start time falls back to pid liveness alone', () => {
    const participant = {
      pid: process.pid, startTime: null, incarnation: 'legacy', session: 'legacy',
      what: 'landing', since: new Date(0).toISOString(),
    }
    expect(staleProjectLockHolder(participant)).toBeNull()
    expect(staleProjectLockHolder({ ...participant, pid: 2_147_483_647 }))
      .toBe('dead holder pid 2147483647')
  })

  test('malformed process identity is unknown, never stale', () => {
    const original = Bun.spawnSync
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[], options?: any) =>
      cmd[0] === 'ps'
        ? { exitCode: 0, stdout: Buffer.from('garbage\n'), stderr: Buffer.from(''), success: true }
        : original(cmd, options)) as typeof Bun.spawnSync)
    try {
      expect(processStartTime(process.pid)).toBeNull()
      expect(staleProjectLockHolder({
        pid: process.pid, startTime: 'Sat Sep  6 12:34:56 2026', incarnation: 'a',
        session: 's', what: 'landing', since: new Date(0).toISOString(),
      })).toBeNull()
    } finally {
      spawn.mockRestore()
    }
  })

  test('reclaim refuses to remove a live replacement after classifying a stale owner', () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-landing.lock')
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), `${JSON.stringify({
        pid: process.pid, startTime: processStartTime(process.pid), incarnation: 'live-b',
        session: 'live', what: 'replacement', since: new Date().toISOString(),
      })}\n`)
      expect(reclaimStaleProjectLock(repo, 'landing')).toBeNull()
      expect(existsSync(lock)).toBe(true)
      expect(JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')).incarnation).toBe('live-b')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a tree whose disk contents disagree with HEAD is never returned', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-914')
    try {
      expect(() => createWithTool({
        branch: 'orch/{id}',
        create: compoundCreate(
          `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
          `printf 'not HEAD\\n' > "${path}/kept.txt" && ` +
          `printf 'from another tree\\n' > "${path}/contamination.txt" && echo "${path}"`),
      }, repo, 914)).toThrow(/worktree verification failed:[\s\S]*kept\.txt[\s\S]*contamination\.txt/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unreadable worktree index is a verification failure, not a clean tree', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-915')
    try {
      expect(() => createWithTool({
        branch: 'orch/{id}',
        create: compoundCreate(
          `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
          `printf broken > "$(${hermeticGitCommand} -C "${path}" rev-parse --git-path index)" && echo "${path}"`),
      }, repo, 915)).toThrow(/worktree verification failed: could not compare[\s\S]*index/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a successful tool postcondition failure names its branch and remove command', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      expect(() => createWithTool(
        {
          branch: 'technical/{key}-orch-{id}',
          create: declaredCreate('echo', [join(repo, 'missing-tree')]),
          remove: 'scripts/worktree remove {branch}',
        },
        process.cwd(), 735, undefined, 'STO-993',
      )).toThrow("scripts/worktree remove 'technical/STO-993-orch-735'")
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches a tool whose template asks for it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'based-746')
    try {
      process.chdir(tree)
      const expected = resolveBase(process.cwd(), 'main')
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" {base} >/dev/null && ` +
            `echo "${custom}"`),
          remove: 'git worktree remove {path}',
        },
        process.cwd(), 746, undefined, undefined, 'main',
      )
      expect(w.base).toBe(expected)
      expect(git(custom, 'rev-parse', 'HEAD')).toBe(expected)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a command tool records the base its worktree actually uses', () => {
    const { repo, tree } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'self-based-746')
    try {
      git(repo, 'branch', 'tool-floor', 'main')
      writeFileSync(join(repo, 'later.txt'), 'later\n')
      git(repo, 'add', 'later.txt')
      git(repo, 'commit', '-m', 'later')
      const expected = resolveBase(repo, 'tool-floor')

      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" tool-floor ` +
            `>/dev/null && echo "${custom}"`),
          remove: 'git worktree remove {path}',
        },
        tree, 746,
      )

      expect(w.base).toBe(expected)
      expect(w.base).not.toBe(resolveBase(repo, 'main'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base without {base} still cuts the key-named branch at that commit', () => {
    const { repo, tree } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'no-slot-747')
    try {
      const expected = resolveBase(repo, 'main')
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add "${custom}" HEAD >/dev/null && echo "${custom}"`),
          branch: 'task/{id}',
          remove: 'git worktree remove {path}',
        },
        tree, 747, undefined, undefined, 'main',
      )
      expect(w.mintedBranch).toBe('task/747')
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(expected)
      expect(git(repo, 'rev-parse', 'refs/heads/task/747')).toBe(expected)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches the recipe path and overrides its default', () => {
    const { repo, tree } = scratchRepo()
    try {
      git(repo, 'branch', 'requested-base', 'main')
      writeFileSync(join(repo, 'later.txt'), 'later\n')
      git(repo, 'add', 'later.txt')
      git(repo, 'commit', '-m', 'later')
      const expected = resolveBase(repo, 'requested-base')

      const w = createWithTool(
        { recipe: { baseRef: 'main' } }, tree, 748,
        undefined, undefined, 'requested-base',
      )

      expect(w.base).toBe(expected)
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(expected)
      expect(existsSync(join(w.path, 'later.txt'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
