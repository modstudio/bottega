// Tests run.ts: the run row carries the pure worker finalization decision.
import { describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { workerReply } from '../test/fixtures/replies.ts'
import { addRun, dir } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { worktreeGitDir } from './git-environment.ts'
import { run as runJob } from './run.ts'
import { createWorktree, workerSharedGitRoots } from './worktree.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'

describe('a writing worker must return evidence of completed work', () => {
  async function runInCleanTree(output: string): Promise<Awaited<ReturnType<typeof runJob>>> {
    const repo = cloneRepository('orch-empty-write-')
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    const added = Bun.spawnSync(['git', 'add', 'seed.txt'], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (added.exitCode !== 0) throw new Error(added.stderr.toString())
    const committed = Bun.spawnSync(['git', '-c', 'user.name=Orch Test',
      '-c', 'user.email=orch@example.invalid', 'commit', '-m', 'seed'], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 76)
    const transport = scriptedTransportSequence([[{ kind: 'completed', output }]])
    transport.install()
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const rootPrompt = join(dir, `write-root-${parent}.prompt.txt`)
    writeFileSync(rootPrompt, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(rootPrompt, parent)
    try {
      return await runJob({ job: 'implement', prompt: 'continue', cwd: tree.path,
        noFailover: true, resume: { parent, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree } })
    } finally {
      const options = transport.startOptions()[0]!
      expect(options.sandbox).toBe('workspace-write')
      expect(options.writableRoots![0]?.endsWith('/scratch')).toBe(true)
      expect(options.writableRoots!.slice(1)).toEqual([
        worktreeGitDir(tree.path), ...workerSharedGitRoots(tree.path, tree.branch),
      ])
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(rootPrompt, { force: true })
    }
  }

  test('done with no claimed or measured change and no test run is failed', async () => {
    let failure: Error & { runId?: number } | null = null
    try {
      await runInCleanTree(JSON.stringify(workerReply({
        files_changed: [], tests: { command: null, ran: false, passed: null, detail: null },
      })))
    } catch (e) { failure = e as Error & { runId?: number } }
    expect(failure?.message).toContain('reported done with no change and no test run')
    expect(failure?.runId).toBeDefined()
    const row = db().query('SELECT status, error, files_changed, changed_paths, route_reason FROM run WHERE id=?')
      .get(failure!.runId!) as { status: string; error: string; files_changed: number;
        changed_paths: string; route_reason: string }
    expect(row.status).toBe('failed')
    expect(row.files_changed).toBe(0)
    expect(JSON.parse(row.changed_paths)).toEqual([])
    expect(row.error).toContain('reported done with no change and no test run')
    expect(row.error).not.toContain('review path retargeting indeterminate:')
    expect(row.route_reason).toContain(
      'repository path retargeting not applied because the turn is already bound to its worktree',
    )
  })
})
