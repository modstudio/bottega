import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENTS, CODEX_ASK_ENV_VARS, CODEX_EXEC_SANDBOX, addRun, assertCallerAncestry, assertSharedRefGuardOutsideWritableRoots, carryWorkingState, checkoutHasUncommittedWork, createWorktree, db, dir, hermeticGitEnv, prepareSharedRefGuard, prepareWorktreeObjects, removeFor, removeSharedRefGuard, reviewReply, runJob, upsertProject, workerReply, workerSharedGitRoots, worktreeGitDir } from '../test/fixture.ts'

describe("the sandbox an agent is launched with", () => {
test('follows the job, not a project register entry', async () => {
    // The register used to declare agentSandbox and default registered
    // projects to exec. Dispatch stopped reading it in 0f8681b and kept
    // handing every repository job workspace-write. A round-trip through
    // the register is the test that missed that, so this watches the
    // argv the agent is actually launched with.
    const repo = mkdtempSync(join(tmpdir(), 'orch-sandbox-dispatch-'))
    const script = join(dir, 'sandbox-dispatch-worker.ts')
    writeFileSync(script, 'process.stdout.write("ok")\n')
    const agent = AGENTS.codex!
    const original = {
      bin: agent.bin, argv: agent.argv, readsOut: agent.readsOut, stdin: agent.stdin,
    }
    const launched: Array<string | undefined> = []
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      runGit('init', '-b', 'main')
      runGit('config', 'user.email', 'orch-test@example.invalid')
      runGit('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'seed.txt'), 'seed\n')
      runGit('add', 'seed.txt')
      runGit('commit', '-m', 'fixture')
      agent.bin = process.execPath
      agent.stdin = false
      agent.readsOut = false
      agent.argv = (o) => {
        launched.push(o.sandbox)
        return [script]
      }
      process.env.ORCH_DEPTH = '0'

      await runJob({ job: 'file-question', prompt: 'p', cwd: repo, agent: 'codex' })
      upsertProject({ name: 'sandbox-dispatch', path: repo })
      await runJob({ job: 'file-question', prompt: 'p', cwd: repo, agent: 'codex' })
      writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(reviewReply(1)))})\n`)
      await runJob({ job: 'review-lens-inline', prompt: 'p', cwd: repo, agent: 'codex', lens: 'inline' })

      expect(launched).toEqual(['workspace-write', 'workspace-write', 'read-only'])
    } finally {
      agent.bin = original.bin
      agent.argv = original.argv
      agent.readsOut = original.readsOut
      agent.stdin = original.stdin
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(script, { force: true })
    }
  })

  test('exec is what the widest level actually asks codex for', () => {
    const argv = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'exec' })
    expect(argv).toContain(CODEX_EXEC_SANDBOX)
    // And the narrow levels stay narrow.
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o' })).toContain('read-only')
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'workspace-write' }))
      .toContain('workspace-write')
  })

  test('asking for MCP gives up exec, and that is the intended trade', () => {
    // --approve-for-me is required for MCP and is mutually exclusive with
    // --sandbox. Review lenses get execution and use no MCP; implementation
    // workers keep the ask channel, because a worker that cannot ask guesses.
    const argv = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', sandbox: 'exec', mcp: true })
    expect(argv).toContain('--approve-for-me')
    expect(argv).not.toContain(CODEX_EXEC_SANDBOX)
  })

  test('Codex MCP forwards the run identity into orch-ask on first and resumed turns', () => {
    const overlay = `mcp_servers.orch-ask.env_vars=${JSON.stringify([...CODEX_ASK_ENV_VARS])}`
    const first = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', mcp: true })
    expect(first).toContain('--strict-config')
    expect(first).toContain('--approve-for-me')
    expect(first).toContain(overlay)
    const resumed = AGENTS.codex!.resumeArgv!({
      prompt: 'p', out: '/tmp/o', mcp: true, session: 'thread',
    })
    expect(resumed).toContain('--strict-config')
    expect(resumed).toContain('--approve-for-me')
    expect(resumed).toContain(overlay)
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o' })).not.toContain(overlay)
  })

  test('Codex below its minimum CLI version is refused before the worker spawn', async () => {
    const fake = join(dir, 'codex-below-minimum')
    const spawned = join(dir, 'codex-below-minimum.spawned')
    writeFileSync(
      fake,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.153.3'; exit 0; fi\ntouch '${spawned}'\n`,
    )
    chmodSync(fake, 0o755)
    const agent = AGENTS.codex!
    const originalBin = agent.bin
    const priorDepth = process.env.ORCH_DEPTH
    agent.bin = fake
    process.env.ORCH_DEPTH = '0'
    try {
      await expect(runJob({
        job: 'summarize', prompt: 'summarize this', agent: 'codex', cwd: dir,
      })).rejects.toThrow('codex 0.153.3 is below minimum 0.153.4')
      expect(existsSync(spawned)).toBe(false)
    } finally {
      agent.bin = originalBin
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(fake, { force: true })
      rmSync(spawned, { force: true })
    }
  })

  test('a writing worktree grants codex its metadata, common objects, and run-ref directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-codex-git-dir-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', 'kept.txt')
      git('commit', '-m', 'base')
      const tree = createWorktree(repo, 125)
      const sibling = createWorktree(repo, 127)
      const ownGitDir = worktreeGitDir(tree.path)
      const siblingGitDir = worktreeGitDir(sibling.path)
      const sharedRoots = workerSharedGitRoots(tree.path, tree.branch)
      const argv = AGENTS.codex!.argv({
        prompt: 'p', out: '/tmp/o', mcp: true, write: true,
        writableRoots: [ownGitDir, ...sharedRoots],
      })
      const configs = argv.filter((arg) => arg.includes('='))
      const writable = configs.find((arg) => arg.startsWith('sandbox_workspace_write.'))!

      expect(JSON.parse(writable.split('=', 2)[1]!)).toEqual([ownGitDir, ...sharedRoots])
      expect(ownGitDir).toBe(realpathSync(join(repo, '.git', 'worktrees', 'orch-125')))
      expect(writable).not.toContain(`${realpathSync(join(repo, '.git'))}"]`)
      expect(writable).not.toContain(siblingGitDir)
      expect(sharedRoots).toContain(join(realpathSync(join(repo, '.git')), 'objects'))
      expect(sharedRoots).toContain(join(realpathSync(join(repo, '.git')), 'refs', 'heads', 'orch'))
      expect(sharedRoots).toContain(join(realpathSync(join(repo, '.git')), 'logs', 'refs', 'heads', 'orch'))
      expect(writable).not.toContain(`${join(realpathSync(join(repo, '.git')), 'refs', 'heads')}"]`)
      expect(writable).not.toContain(join(repo, '.git', 'config'))
      expect(configs.some((arg) => arg.includes('GIT_OBJECT_DIRECTORY'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a new worktree receives the caller state without changing the caller', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-carry-state-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
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
    const repo = mkdtempSync(join(tmpdir(), 'orch-stale-caller-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
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
    const repo = mkdtempSync(join(tmpdir(), 'orch-carry-default-off-'))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-carry-default-off-bin-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      writeFileSync(join(repo, 'kept.txt'), 'dirty tracked\n')
      writeFileSync(join(repo, 'new.txt'), 'dirty untracked\n')
      expect(checkoutHasUncommittedWork(repo)).toBe(true)

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const launched = Bun.spawnSync(
        [process.execPath, CLI, 'do', 'implement', 'leave the dirt behind', '--agent', 'grok', '--follow'],
        {
          cwd: repo,
          env: {
            ...process.env, PATH: `${binDir}:${process.env.PATH}`,
            ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(launched.exitCode).toBe(0)
      expect(launched.stderr.toString()).toContain(
        'this checkout has uncommitted work that will not be carried into the worker',
      )
      expect(launched.stderr.toString()).toContain('pass --carry to send it with the run')

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
      rmSync(binDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('an explicit --carry launch with a dirty checkout carries and records as before', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-carry-opt-in-'))
    const binDir = mkdtempSync(join(tmpdir(), 'orch-carry-opt-in-bin-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(join(binDir, 'grok'), `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      writeFileSync(join(repo, 'kept.txt'), 'carried tracked\n')
      writeFileSync(join(repo, 'new.txt'), 'carried untracked\n')

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const launched = Bun.spawnSync(
        [process.execPath, CLI, 'do', 'implement', 'send the dirt', '--agent', 'grok', '--carry', '--follow'],
        {
          cwd: repo,
          env: {
            ...process.env, PATH: `${binDir}:${process.env.PATH}`,
            ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(launched.exitCode).toBe(0)
      expect(launched.stderr.toString()).not.toContain('will not be carried')

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

      const shown = Bun.spawnSync(
        [process.execPath, CLI, 'diff', String(row.id), '--quiet'],
        { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(shown.stdout.toString()).toContain('carry: 1 tracked path(s), 1 untracked path(s)')
      expect(shown.stdout.toString()).toContain('carry tracked: "kept.txt"')
      expect(shown.stdout.toString()).toContain('carry untracked: "new.txt"')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('a behind caller is refused whether or not carrying was requested', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-stale-caller-launch-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    const priorDepth = process.env.ORCH_DEPTH
    const fakeAgent = join(dir, 'carry-behind-agent.sh')
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(fakeAgent, `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(fakeAgent, 0o755)
    agent.bin = fakeAgent
    agent.argv = () => []
    process.env.ORCH_DEPTH = '0'
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
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
      agent.bin = originalBin
      agent.argv = originalArgv
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(fakeAgent, { force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('every turn in a three-turn chain declares the inherited carry audit', async () => {
    const makeRepo = () => {
      const repo = mkdtempSync(join(tmpdir(), 'orch-carry-chain-'))
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(['git', ...args], {
          cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      }
      git('init', '-b', 'main')
      git('config', 'user.email', 'orch-test@example.invalid')
      git('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, '.gitignore'), '.claude/\n')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', '.gitignore', 'kept.txt')
      git('commit', '-m', 'base')
      return repo
    }
    const dirty = makeRepo()
    const clean = makeRepo()
    const applyRepo = mkdtempSync(join(tmpdir(), 'orch-carry-apply-'))
    const agent = AGENTS.grok!
    const originalBin = agent.bin
    const originalArgv = agent.argv
    const originalResume = agent.resumeArgv
    const priorDepth = process.env.ORCH_DEPTH
    const fakeAgent = join(dir, 'carry-chain-agent.sh')
    const reply = JSON.stringify({
      type: 'result', subtype: 'success', result: JSON.stringify(workerReply()),
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    })
    writeFileSync(fakeAgent, `#!/bin/sh\nprintf '%s\\n' '${reply}'\n`)
    chmodSync(fakeAgent, 0o755)
    agent.bin = fakeAgent
    agent.argv = () => []
    agent.resumeArgv = () => []
    process.env.ORCH_DEPTH = '0'

    const chain = async (repo: string) => {
      const first = await runJob({
        job: 'implement', prompt: 'carry audit', cwd: repo, agent: 'grok', carry: true,
      })
      const tree = first.worktree!
      const second = await runJob({
        job: 'implement', prompt: 'turn two', cwd: tree.path,
        resume: {
          parent: first.id, agent: 'grok', session: 'carry-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      const third = await runJob({
        job: 'implement', prompt: 'turn three', cwd: tree.path,
        resume: {
          parent: first.id, agent: 'grok', session: 'carry-session', turn: 3,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      return { ids: [first.id, second.id, third.id], tree }
    }

    try {
      writeFileSync(join(dirty, 'kept.txt'), 'carried tracked\n')
      writeFileSync(join(dirty, 'new.txt'), 'carried untracked\n')
      const dirtyChain = await chain(dirty)
      const dirtyRows = db().query(
        `SELECT carry_happened, carry_base_commit, carry_tracked_paths, carry_untracked_paths,
                route_reason
           FROM run WHERE id IN (?,?,?) ORDER BY turn`,
      ).all(...dirtyChain.ids) as Array<{
        carry_happened: number; carry_base_commit: string
        carry_tracked_paths: string; carry_untracked_paths: string; route_reason: string
      }>
      expect(dirtyRows).toHaveLength(3)
      for (const row of dirtyRows) {
        expect(row.carry_happened).toBe(1)
        expect(row.carry_base_commit).toBe(dirtyChain.tree.base)
        expect(JSON.parse(row.carry_tracked_paths)).toEqual(['kept.txt'])
        expect(JSON.parse(row.carry_untracked_paths)).toEqual(['new.txt'])
      }
      expect(dirtyRows[1]!.route_reason).toContain(
        'repository path retargeting not applied because the turn is already bound to its worktree',
      )
      expect(dirtyRows[2]!.route_reason).toContain(
        'repository path retargeting not applied because the turn is already bound to its worktree',
      )

      const CLI = new URL('cli.ts', import.meta.url).pathname
      const shown = Bun.spawnSync(
        [process.execPath, CLI, 'diff', String(dirtyChain.ids[2]), '--quiet'],
        { env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(shown.exitCode).toBe(0)
      const output = shown.stdout.toString()
      expect(output.match(/^base: /gm)).toHaveLength(1)
      expect(output).toContain('carry: 1 tracked path(s), 1 untracked path(s)')
      expect(output).toContain('carry tracked: "kept.txt"')
      expect(output).toContain('carry untracked: "new.txt"')
      const cloned = Bun.spawnSync(['git', 'clone', '--quiet', dirty, applyRepo], {
        env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(cloned.exitCode).toBe(0)
      const applies = Bun.spawnSync(['git', 'apply', '--check', '-'], {
        cwd: applyRepo, env: hermeticGitEnv(), stdin: shown.stdout, stdout: 'pipe', stderr: 'pipe',
      })
      expect(applies.exitCode).toBe(0)

      const cleanChain = await chain(clean)
      for (const id of cleanChain.ids) {
        const cleanShown = Bun.spawnSync([process.execPath, CLI, 'diff', String(id), '--quiet'], {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(cleanShown.exitCode).toBe(0)
        expect(cleanShown.stdout.toString()).toContain(
          'carry: none (0 tracked paths, 0 untracked paths)',
        )
      }
    } finally {
      agent.bin = originalBin
      agent.argv = originalArgv
      agent.resumeArgv = originalResume
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(fakeAgent, { force: true })
      rmSync(dirty, { recursive: true, force: true })
      rmSync(clean, { recursive: true, force: true })
      rmSync(applyRepo, { recursive: true, force: true })
    }
  }, 20_000)

  test('orch diff resolves a new blob staged in the worker-local object database', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-isolated-objects-'))
    const foreignObjects = mkdtempSync(join(tmpdir(), 'orch-foreign-objects-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, ['init', '-b', 'main'])
      git(repo, ['config', 'user.email', 'orch-test@example.invalid'])
      git(repo, ['config', 'user.name', 'Orch Test'])
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
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const diff = Bun.spawnSync([process.execPath, CLI, 'diff', String(id)], {
        env: {
          ...process.env, GIT_OBJECT_DIRECTORY: foreignObjects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: foreignObjects,
          ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })

      expect(diff.exitCode).toBe(0)
      expect(diff.stdout.toString()).toContain('diff --git a/new.txt b/new.txt')
      expect(diff.stdout.toString()).toContain(`+${content.trim()}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignObjects, { recursive: true, force: true })
    }
  })

  test('orch diff anchors at current trunk and --since-base restores the recorded range', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-diff-trunk-')))
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
      g(repo, 'init', '-b', 'main')
      g(repo, 'config', 'user.email', 'orch-test@example.invalid')
      g(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      g(repo, 'add', 'base.txt')
      g(repo, 'commit', '-m', 'base')
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
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const show = (...extra: string[]) => Bun.spawnSync(
        [process.execPath, CLI, 'diff', String(id), '--quiet', ...extra],
        {
          env: {
            ...process.env, GIT_OBJECT_DIRECTORY: foreignObjects,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: foreignObjects,
            ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )

      const current = show()
      expect(current.exitCode).toBe(0)
      const currentText = current.stdout.toString()
      expect(currentText).toContain(`base: ${recorded} (recorded)`)
      expect(currentText).toContain(`since: ${trunk} (trunk main)`)
      expect(currentText).toContain('DEV-283 worker change')
      expect(currentText).toContain('diff --git a/worker.txt b/worker.txt')
      expect(currentText).not.toContain('diff --git a/trunk-one.txt b/trunk-one.txt')
      expect(currentText).not.toContain('diff --git a/trunk-two.txt b/trunk-two.txt')

      const full = show('--since-base')
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
      const discarded = show()
      expect(discarded.exitCode).toBe(0)
      const discardedText = discarded.stdout.toString()
      expect(discardedText).toContain(`since: ${trunk} (trunk main; worktree discarded)`)
      expect(discardedText).toContain('DEV-283 worker change')
      expect(discardedText).toContain('diff --git a/worker.txt b/worker.txt')
      expect(discardedText).not.toContain('diff --git a/trunk-one.txt b/trunk-one.txt')
      expect(discardedText).not.toContain('diff --git a/trunk-two.txt b/trunk-two.txt')

      const discardedFull = show('--since-base')
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

  test('orch diff finds an unregistered repository after its worktree is discarded', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-diff-unregistered-')))
    const worker = join(repo, 'worker')
    const g = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      g(repo, 'init', '-b', 'main')
      g(repo, 'config', 'user.email', 'orch-test@example.invalid')
      g(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      g(repo, 'add', 'base.txt')
      g(repo, 'commit', '-m', 'base')
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
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const shown = Bun.spawnSync([process.execPath, CLI, 'diff', String(id), '--quiet'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })

      expect(shown.exitCode).toBe(0)
      const output = shown.stdout.toString()
      expect(output).toContain(`since: ${trunk} (trunk main; worktree discarded)`)
      expect(output).toContain('diff --git a/worker.txt b/worker.txt')
      expect(output).not.toContain('diff --git a/trunk.txt b/trunk.txt')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the shared-ref guard does not run project hooks in a scratch repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-project-hooks-'))
    const scratch = mkdtempSync(join(tmpdir(), 'orch-unrelated-scratch-'))
    const cleanConfig = { GIT_CONFIG_COUNT: '0' }
    const git = (cwd: string, args: string[], env: Record<string, string> = cleanConfig) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.email', 'orch-test@example.invalid']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.name', 'Orch Test']).exitCode).toBe(0)
      const projectHooks = join(repo, '.githooks')
      const actualProjectHooks = join(repo, '.actual-hooks')
      mkdirSync(projectHooks)
      mkdirSync(actualProjectHooks)
      writeFileSync(join(projectHooks, 'commit-msg'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(projectHooks, 'commit-msg'), 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['commit', '--no-verify', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 156)
      const actualReferenceHook = join(actualProjectHooks, 'reference-transaction')
      writeFileSync(actualReferenceHook, '#!/bin/sh\nexit 1\n')
      chmodSync(actualReferenceHook, 0o755)
      symlinkSync(actualReferenceHook, join(projectHooks, 'reference-transaction'))

      const guardEnv = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      expect(guardEnv.GIT_CONFIG_VALUE_0).toBe(join(realpathSync(repo), '.git', 'orch-guards', '156'))
      expect(readdirSync(guardEnv.GIT_CONFIG_VALUE_0))
        .toEqual(['reference-transaction'])
      const installedWrapper = readFileSync(
        join(guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8',
      )
      expect(installedWrapper).toContain(Buffer.from(realpathSync(actualReferenceHook)).toString('base64'))
      expect(installedWrapper).not.toContain(Buffer.from(
        join(projectHooks, 'reference-transaction'),
      ).toString('base64'))
      const installedReferenceHook = join(
        guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction',
      )
      expect(installedWrapper).not.toContain(
        `'${installedReferenceHook}' "$@"`,
      )
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = guardEnv.GIT_CONFIG_VALUE_0
      try {
        expect(prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)).toEqual(guardEnv)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      expect(readFileSync(
        join(guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8',
      )).toBe(installedWrapper)

      expect(git(scratch, ['init', '-b', 'main'], guardEnv).exitCode).toBe(0)
      expect(git(scratch, ['config', 'user.email', 'orch-test@example.invalid'], guardEnv).exitCode).toBe(0)
      expect(git(scratch, ['config', 'user.name', 'Orch Test'], guardEnv).exitCode).toBe(0)
      writeFileSync(join(scratch, 'fixture.txt'), 'fixture\n')
      expect(git(scratch, ['add', 'fixture.txt'], guardEnv).exitCode).toBe(0)
      const committed = git(scratch, ['commit', '-m', 'test fixture'], guardEnv)
      expect(committed.exitCode).toBe(0)
      expect(committed.stderr.toString()).toBe('')

      const scratchTree = createWorktree(scratch, 165)
      const scratchObjects = prepareWorktreeObjects(scratchTree.path)
      writeFileSync(join(scratchTree.path, 'private.txt'), 'scratch-private\n')
      expect(git(scratchTree.path, ['add', 'private.txt'], {
        ...guardEnv, ...scratchObjects,
      }).exitCode).toBe(0)
      const privateCommit = git(scratchTree.path, ['commit', '-m', 'private fixture'], {
        ...guardEnv, ...scratchObjects,
      })
      expect(privateCommit.exitCode).toBe(0)
      expect(privateCommit.stderr.toString()).toBe('')
      const privateOid = git(scratchTree.path, ['rev-parse', 'HEAD'], scratchObjects)
        .stdout.toString().trim()
      expect(existsSync(join(
        scratchObjects.GIT_OBJECT_DIRECTORY, privateOid.slice(0, 2), privateOid.slice(2),
      ))).toBe(true)
      expect(existsSync(join(
        scratch, '.git', 'objects', privateOid.slice(0, 2), privateOid.slice(2),
      ))).toBe(false)
      const updated = git(scratchTree.path, [
        'update-ref', 'refs/heads/scratch-private', privateOid,
      ], { ...guardEnv, ...scratchObjects })
      expect(updated.exitCode).toBe(0)
      expect(updated.stderr.toString()).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('dispatch containment refuses a guard inside a writable root and names the invariant', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-guard-contained-'))
    const guard = join(root, 'orch-guards', '248')
    try {
      mkdirSync(guard, { recursive: true })
      expect(() => assertSharedRefGuardOutsideWritableRoots(guard, [root])).toThrow(
        'THE GUARD LIVES OUTSIDE EVERY ROOT THE WORKER CAN WRITE invariant failed',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('shared-ref guard teardown removes the run directory and accepts it already missing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-teardown-'))
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(['add', 'base.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.email=orch-test@example.invalid', '-c', 'user.name=Orch Test',
        'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 248)
      const guard = prepareSharedRefGuard(tree.path)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(true)
      expect(removeFor(tree, repo, false, false, 248).removed).toBe(true)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(false)
      expect(() => removeSharedRefGuard(repo, 248)).not.toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('worktree marker ownership wins over a resumed child cleanup fallback', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-resumed-cleanup-'))
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(['add', 'base.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.email=orch-test@example.invalid', '-c', 'user.name=Orch Test',
        'commit', '-m', 'base']).exitCode).toBe(0)
      const root = 251
      const resumedChild = 252
      const tree = createWorktree(repo, root)
      const rootGuard = prepareSharedRefGuard(tree.path)
      const childGuard = join(realpathSync(repo), '.git', 'orch-guards', String(resumedChild))
      mkdirSync(childGuard)

      expect(removeFor(tree, repo, false, false, resumedChild).removed).toBe(true)
      expect(existsSync(rootGuard.GIT_CONFIG_VALUE_0)).toBe(false)
      expect(existsSync(childGuard)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard litter cleanup reclaims terminal orphans and skips live runs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-litter-'))
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    const terminal = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(['add', 'base.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.email=orch-test@example.invalid', '-c', 'user.name=Orch Test',
        'commit', '-m', 'base']).exitCode).toBe(0)
      const guardRoot = join(realpathSync(repo), '.git', 'orch-guards')
      mkdirSync(join(guardRoot, String(terminal)), { recursive: true })
      mkdirSync(join(guardRoot, String(live)), { recursive: true })
      writeFileSync(join(guardRoot, String(terminal), 'reference-transaction'), 'litter\n')
      writeFileSync(join(guardRoot, String(live), 'reference-transaction'), 'live\n')

      const tree = createWorktree(repo, 250)
      prepareSharedRefGuard(tree.path)

      expect(existsSync(join(guardRoot, String(terminal)))).toBe(false)
      expect(existsSync(join(guardRoot, String(live)))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a common-dir guard refuses main for a worker on a flat branch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-flat-branch-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 249)
      expect(git(tree.path, ['branch', '-m', 'flat-worker']).exitCode).toBe(0)
      const guard = prepareSharedRefGuard(tree.path, 'refs/heads/flat-worker')
      expect(guard.GIT_CONFIG_VALUE_0).toBe(join(realpathSync(repo), '.git', 'orch-guards', '249'))
      const forbidden = git(tree.path, ['update-ref', 'refs/heads/main', 'HEAD'], guard)
      expect(forbidden.exitCode).not.toBe(0)
      expect(forbidden.stderr.toString()).toContain(
        'refusing shared ref update refs/heads/main: this worker may update only refs/heads/flat-worker',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard preparation is idempotent under its inherited hooks path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-idempotent-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    const sharedGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
    const sharedBefore = readFileSync(sharedGuard)
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.email', 'orch-test@example.invalid']).exitCode).toBe(0)
      expect(git(repo, ['config', 'user.name', 'Orch Test']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 225)

      const first = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      const installed = join(first.GIT_CONFIG_VALUE_0, 'reference-transaction')
      expect(readFileSync(installed)).toEqual(readFileSync(sharedGuard))

      const installedBefore = readFileSync(installed)
      writeFileSync(join(first.GIT_CONFIG_VALUE_0,
        '.reference-transaction-99999999-interrupted'), 'litter\n')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = first.GIT_CONFIG_VALUE_0
      let second: ReturnType<typeof prepareSharedRefGuard> | undefined
      try {
        second = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      expect(second).toEqual(first)
      expect(readFileSync(sharedGuard)).toEqual(sharedBefore)
      expect(readFileSync(installed)).toEqual(installedBefore)
      expect(readdirSync(first.GIT_CONFIG_VALUE_0)).toEqual(['reference-transaction'])
      expect(readFileSync(installed)).toEqual(readFileSync(sharedGuard))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard config reads ignore an inherited worker hooks path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-hostile-config-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      const hostileHooks = join(repo, 'hostile-hooks')
      mkdirSync(projectHooks)
      mkdirSync(hostileHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      const hostileHook = join(hostileHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\necho project\n')
      writeFileSync(hostileHook, '#!/bin/sh\necho hostile\n')
      chmodSync(projectHook, 0o755)
      chmodSync(hostileHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 229)

      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = hostileHooks
      let guardEnv: ReturnType<typeof prepareSharedRefGuard> | undefined
      try {
        guardEnv = prepareSharedRefGuard(tree.path)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      const wrapper = readFileSync(join(guardEnv!.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8')
      expect(wrapper).toContain(Buffer.from(realpathSync(projectHook)).toString('base64'))
      expect(wrapper).not.toContain(Buffer.from(realpathSync(hostileHook)).toString('base64'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
