/** Process boundary for resumed-run ref guard preparation and cleanup. */
import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, compoundCreate, createWithTool, createWorktree, db, declaredCreate, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, nowIso, prepareSharedRefGuard, prepareWorktreeObjects, processStartTime, projectLockDir, reclaimStaleProjectLock, removeFor, resolveBase, runJob, staleProjectLockHolder, upsertProject, withProjectLock, withWorktreeCreateLock, worktreeDescribeFixture } from '../fixture.ts'
import { scriptedTransportSequence } from '../fake-transport.ts'


describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo, markScratchRepoOwner } = worktreeDescribeFixture()
  test('resumed child cleanup removes only the discarding run guard, not the marker owner guard', () => {
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
      expect(existsSync(rootGuard.GIT_CONFIG_VALUE_0)).toBe(true)
      expect(existsSync(childGuard)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a resumed no-repository job still prepares the shared ref guard', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-repo-resume-'))
    const promptPath = join(repo, 'root.prompt.txt')
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'seed.txt'), 'seed\n')
      expect(git(['add', 'seed.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid',
        'commit', '-m', 'seed']).exitCode).toBe(0)
      const tree = createWorktree(repo, 462)
      const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
      writeFileSync(promptPath, 'original implementation spec')
      db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, parent)
      scriptedTransportSequence([[{ kind: 'completed', output: 'summary' }]], (options) => {
        expect(options.gitConfigEnvironment?.GIT_CONFIG_VALUE_0).toBeTruthy()
        expect(existsSync(options.gitConfigEnvironment!.GIT_CONFIG_VALUE_0!)).toBe(true)
        const privateObjects = mkdtempSync(join(tmpdir(), 'orch-private-objects-'))
        const commonDir = Bun.spawnSync([
          'git', 'rev-parse', '--path-format=absolute', '--git-common-dir',
        ], { cwd: tree.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
        expect(commonDir.exitCode).toBe(0)
        const objectEnvironment = {
          GIT_OBJECT_DIRECTORY: privateObjects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir.stdout.toString().trim(), 'objects'),
        }
        try {
          const object = Bun.spawnSync(['git', 'commit-tree', 'HEAD^{tree}', '-m', 'private commit'], {
            cwd: tree.path, env: { ...hermeticGitEnv(), ...objectEnvironment },
            stdout: 'pipe', stderr: 'pipe',
          })
          expect(object.exitCode).toBe(0)
          const update = Bun.spawnSync([
            'git', 'update-ref', 'refs/heads/forbidden', object.stdout.toString().trim(),
          ], {
            cwd: tree.path,
            env: { ...hermeticGitEnv(), ...objectEnvironment, ...options.gitConfigEnvironment },
            stdout: 'pipe', stderr: 'pipe',
          })
          expect(update.exitCode).not.toBe(0)
          expect(update.stderr.toString()).toContain(
            'refusing shared ref update refs/heads/forbidden',
          )
        } finally {
          rmSync(privateObjects, { recursive: true, force: true })
        }
      }).install()
      const priorDepth = process.env.ORCH_DEPTH
      process.env.ORCH_DEPTH = '0'
      try {
        await runJob({
          job: 'summarize', prompt: 'summarize', cwd: tree.path, noFailover: true,
          resume: {
            parent, agent: 'codex', session: 'test-session', turn: 2,
            sessionId: 'orch-test-session', worktree: tree,
          },
        })
      } finally {
        if (priorDepth === undefined) delete process.env.ORCH_DEPTH
        else process.env.ORCH_DEPTH = priorDepth
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })


})
