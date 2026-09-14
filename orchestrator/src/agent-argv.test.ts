// Tests agents.ts: agent argv and sandbox selection.
import { expect, test } from 'bun:test'
import { rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { reviewReply } from '../test/fixtures/replies.ts'
import { AGENTS, CODEX_EXEC_SANDBOX } from './agents.ts'
import { worktreeGitDir } from './git-environment.ts'
import { upsertProject } from './projects.ts'
import { run as runJob } from './run.ts'
import { createWorktree, workerSharedGitRoots } from './worktree.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'


test('follows the job, not a project register entry', async () => {
    // The register used to declare agentSandbox and default registered
    // projects to exec. Dispatch stopped reading it in 0f8681b and kept
    // handing every repository job workspace-write. A round-trip through
    // the register is the test that missed that, so this watches the
    // argv the agent is actually launched with.
    const repo = cloneRepository('orch-sandbox-dispatch-')
    const oldDepth = process.env.ORCH_DEPTH
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      writeFileSync(join(repo, 'seed.txt'), 'seed\n')
      runGit('add', 'seed.txt')
      runGit('commit', '-m', 'fixture')
      const transport = scriptedTransportSequence([
        [{ kind: 'completed', output: 'ok' }],
        [{ kind: 'completed', output: 'ok' }],
        [{ kind: 'completed', output: JSON.stringify(reviewReply(1)) }],
      ])
      transport.install()
      process.env.ORCH_DEPTH = '0'

      await runJob({ job: 'file-question', prompt: 'p', cwd: repo, agent: 'codex' })
      upsertProject({ name: 'sandbox-dispatch', path: repo })
      await runJob({ job: 'file-question', prompt: 'p', cwd: repo, agent: 'codex' })
      await runJob({ job: 'review-lens-inline', prompt: 'p', cwd: repo, agent: 'codex', lens: 'inline' })

      expect(transport.startOptions().map((options) => options.sandbox))
        .toEqual(['workspace-write', 'workspace-write', 'read-only'])
    } finally {
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
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

  test('Codex MCP scope is retained on first and resumed turns', () => {
    const first = AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o', mcp: true })
    expect(first).toContain('--strict-config')
    expect(first).toContain('--approve-for-me')
    expect(first.some((arg) => arg.startsWith('mcp_servers.orch-ask='))).toBe(true)
    const resumed = AGENTS.codex!.resumeArgv!({
      prompt: 'p', out: '/tmp/o', mcp: true, session: 'thread',
    })
    expect(resumed).toContain('--strict-config')
    expect(resumed).toContain('--approve-for-me')
    expect(resumed.some((arg) => arg.startsWith('mcp_servers.orch-ask='))).toBe(true)
    expect(AGENTS.codex!.argv({ prompt: 'p', out: '/tmp/o' })
      .some((arg) => arg.startsWith('mcp_servers.'))).toBe(false)
  })

  test('a writing worktree grants codex its metadata, common objects, and run-ref directory', () => {
    const repo = cloneRepository('orch-codex-git-dir-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
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
