// Tests worktree.ts: carryWorkingState and assertCallerAncestry.
import { expect, spyOn, test } from 'bun:test'
import { rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { workerReply } from '../test/fixtures/replies.ts'
import { db } from './db.ts'
import { run as runJob } from './run.ts'
import { assertCallerAncestry, carryWorkingState, changesIn, checkoutHasUncommittedWork, createWorktree } from './worktree.ts'
import { scriptedTransport } from '../test/fake-transport.ts'
import { dispatchCommand } from './dispatch-commands.ts'
import { runDiffCommand } from './run-diff.ts'


  test('a new worktree receives the caller state without changing the caller', () => {
    const repo = cloneRepository('orch-carry-state-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n.claude/\n')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      writeFileSync(join(repo, 'unstaged.txt'), 'base\n')
      writeFileSync(join(repo, 'binary.bin'), new Uint8Array([0, 1, 2, 3]))
      writeFileSync(join(repo, 'deleted.txt'), 'delete me\n')
      git('add', '.')
      git('commit', '-m', 'base')
      git('switch', '-c', 'topic')
      writeFileSync(join(repo, 'branch.txt'), 'committed branch work\n')
      git('add', 'branch.txt')
      git('commit', '-m', 'topic work')

      writeFileSync(join(repo, 'tracked.txt'), 'working state\n')
      git('add', 'tracked.txt')
      writeFileSync(join(repo, 'unstaged.txt'), 'unstaged working state\n')
      writeFileSync(join(repo, 'binary.bin'), new Uint8Array([0, 255, 2, 128]))
      rmSync(join(repo, 'deleted.txt'))
      writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
      writeFileSync(join(repo, 'ignored.txt'), 'runtime only\n')
      const before = Bun.spawnSync(['git', 'status', '--porcelain'], {
        cwd: repo, env: hermeticGitEnv(),
      }).stdout.toString()

      const tree = createWorktree(repo, 134, 'main')
      const carried = carryWorkingState(repo, tree)

      expect(readFileSync(join(tree.path, 'branch.txt'), 'utf8')).toBe('committed branch work\n')
      expect(readFileSync(join(tree.path, 'tracked.txt'), 'utf8')).toBe('working state\n')
      expect(readFileSync(join(tree.path, 'unstaged.txt'), 'utf8')).toBe('unstaged working state\n')
      expect([...readFileSync(join(tree.path, 'binary.bin'))]).toEqual([0, 255, 2, 128])
      expect(existsSync(join(tree.path, 'deleted.txt'))).toBe(false)
      expect(readFileSync(join(tree.path, 'untracked.txt'), 'utf8')).toBe('untracked\n')
      expect(existsSync(join(tree.path, 'ignored.txt'))).toBe(false)
      expect(carried).toEqual({
        base: tree.base,
        // branch.txt is committed branch work. The tree is cut from main, so the
        // carry legitimately brings it forward — and the audit must say so.
        tracked: ['binary.bin', 'branch.txt', 'deleted.txt', 'tracked.txt', 'unstaged.txt'],
        untracked: ['untracked.txt'],
      })
      expect(Bun.spawnSync(['git', 'status', '--porcelain'], {
        cwd: repo, env: hermeticGitEnv(),
      }).stdout.toString()).toBe(before)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("a caller behind the tree's base is refused before its reversions are carried", () => {
    const repo = cloneRepository('orch-stale-caller-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'caller base\n')
      git('add', 'tracked.txt')
      git('commit', '-m', 'caller base')
      const callerHead = git('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'tracked.txt'), 'newer base\n')
      git('commit', '-am', 'newer base')
      const tree = createWorktree(repo, 135)
      git('switch', '--detach', callerHead)

      expect(() => carryWorkingState(repo, tree)).toThrow(
        `caller HEAD ${callerHead} is behind or diverged from the tree's base ${tree.base}; ` +
        `update the caller checkout so its HEAD descends from the tree's base, then retry`,
      )
      expect(() => assertCallerAncestry(repo, tree)).toThrow(
        `caller HEAD ${callerHead} is behind or diverged from the tree's base ${tree.base}; ` +
        `update the caller checkout so its HEAD descends from the tree's base, then retry`,
      )
      expect(readFileSync(join(tree.path, 'tracked.txt'), 'utf8')).toBe('newer base\n')
      expect(git('-C', tree.path, 'status', '--porcelain')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a default launch with a dirty checkout carries nothing and tells the operator', async () => {
    const repo = cloneRepository('orch-carry-default-off-')
    const priorDepth = process.env.ORCH_DEPTH
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      process.env.ORCH_DEPTH = '0'
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      writeFileSync(join(repo, 'kept.txt'), 'dirty tracked\n')
      writeFileSync(join(repo, 'new.txt'), 'dirty untracked\n')
      expect(checkoutHasUncommittedWork(repo)).toBe(true)

      const transport = scriptedTransport([{ kind: 'completed', output: JSON.stringify(workerReply()) }])
      transport.install()
      const errors: string[] = []
      const shown = spyOn(console, 'error').mockImplementation((...values) => errors.push(values.join(' ')))
      await dispatchCommand(['do', 'implement'], {
        has: () => false, flag: () => undefined, values: () => [],
      }, {
        usage: (): never => { throw new Error('usage') },
        doUsage: (): never => { throw new Error('usage') },
        error: (...values) => errors.push(values.join(' ')),
        printRunId: () => {},
        readPrompt: async () => 'leave the dirt behind',
        validateSchema: () => ({}), warnCallerDrift: () => {},
        contractConflicts: () => [], warnImplementContractConflicts: () => {},
        checkoutHasUncommittedWork: () => true, resolveBase: () => ({}),
        implicitReviewWarning: () => '',
        resolveDispatchOptions: async () => ({
          agent: 'grok', transport: 'cli', transportExplicit: false,
          avoid: [], distinctModels: [], mcp: undefined,
        }),
        detach: async () => 1,
        follow: async () => {},
      })
      await runJob({ job: 'implement', prompt: 'leave the dirt behind', cwd: repo, agent: 'grok' })
      shown.mockRestore()
      expect(errors.join('\n')).toContain(
        'this checkout has uncommitted work that will not be carried into the worker',
      )
      expect(errors.join('\n')).toContain('pass --carry to send it with the run')

      const row = db().query(
        `SELECT worktree, carry_happened, carry_tracked_paths, carry_untracked_paths
           FROM run ORDER BY id DESC LIMIT 1`,
      ).get() as {
        worktree: string; carry_happened: number
        carry_tracked_paths: string; carry_untracked_paths: string
      }
      expect(row.carry_happened).toBe(0)
      expect(JSON.parse(row.carry_tracked_paths)).toEqual([])
      expect(JSON.parse(row.carry_untracked_paths)).toEqual([])
      expect(readFileSync(join(row.worktree, 'kept.txt'), 'utf8')).toBe('base\n')
      expect(existsSync(join(row.worktree, 'new.txt'))).toBe(false)
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('an explicit --carry launch with a dirty checkout carries and records as before', async () => {
    const repo = cloneRepository('orch-carry-opt-in-')
    const priorDepth = process.env.ORCH_DEPTH
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      process.env.ORCH_DEPTH = '0'
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      writeFileSync(join(repo, 'kept.txt'), 'carried tracked\n')
      writeFileSync(join(repo, 'new.txt'), 'carried untracked\n')

      const transport = scriptedTransport([{ kind: 'completed', output: JSON.stringify(workerReply()) }])
      transport.install()
      const errors: string[] = []
      const shownErrors = spyOn(console, 'error').mockImplementation((...values) => errors.push(values.join(' ')))
      await runJob({ job: 'implement', prompt: 'send the dirt', cwd: repo, agent: 'grok', carry: true })
      shownErrors.mockRestore()
      expect(errors.join('\n')).not.toContain('will not be carried')

      const row = db().query(
        `SELECT id, worktree, carry_happened, carry_tracked_paths, carry_untracked_paths
           FROM run ORDER BY id DESC LIMIT 1`,
      ).get() as {
        id: number; worktree: string; carry_happened: number
        carry_tracked_paths: string; carry_untracked_paths: string
      }
      expect(row.carry_happened).toBe(1)
      expect(JSON.parse(row.carry_tracked_paths)).toEqual(['kept.txt'])
      expect(JSON.parse(row.carry_untracked_paths)).toEqual(['new.txt'])
      expect(readFileSync(join(row.worktree, 'kept.txt'), 'utf8')).toBe('carried tracked\n')
      expect(readFileSync(join(row.worktree, 'new.txt'), 'utf8')).toBe('carried untracked\n')

      let output = ''
      await runDiffCommand(row.id, { has: () => false }, {
        error: () => {}, write: (value) => { output += value },
        usage: (): never => { throw new Error('usage') }, cleanupRepoRoot: () => repo,
        changesIn, writesRepo: () => true,
      })
      expect(output).toContain('carry: 1 tracked path(s), 1 untracked path(s)')
      expect(output).toContain('carry tracked: "kept.txt"')
      expect(output).toContain('carry untracked: "new.txt"')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('a behind caller is refused whether or not carrying was requested', async () => {
    const repo = cloneRepository('orch-stale-caller-launch-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const priorDepth = process.env.ORCH_DEPTH
    scriptedTransport([]).install()
    process.env.ORCH_DEPTH = '0'
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'caller base\n')
      git('add', 'tracked.txt')
      git('commit', '-m', 'caller base')
      const callerHead = git('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'tracked.txt'), 'newer base\n')
      git('commit', '-am', 'newer base')
      const newer = git('rev-parse', 'HEAD')
      git('switch', '--detach', callerHead)

      for (const carry of [undefined, true] as const) {
        await expect(runJob({
          job: 'implement', prompt: 'should not revert', cwd: repo, agent: 'grok',
          base: newer, carry,
        })).rejects.toThrow(
          `caller HEAD ${callerHead} is behind or diverged from the tree's base ${newer}`,
        )
        expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('caller base\n')
        const leftover = existsSync(join(repo, '.claude', 'worktrees'))
          ? readdirSync(join(repo, '.claude', 'worktrees'))
          : []
        expect(leftover.filter((name) => name.startsWith('orch-'))).toEqual([])
      }
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)
