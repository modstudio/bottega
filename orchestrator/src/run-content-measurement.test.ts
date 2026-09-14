import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixtures/git.ts'
import { db } from './db.ts'
import { worktreeGitDir } from './git-environment.ts'
import { run as runJob } from './run.ts'
import { scriptedTransport } from '../test/fake-transport.ts'
const worktreeMod = await import('./worktree.ts')
describe('content tree measurement', () => {

  test('a measurement failure before vendor spawn is a harness failure with the git message', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-content-tree-failure-'))
    const g = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    const vendorMarker = join(repo, 'vendor-started')
    const oldDepth = process.env.ORCH_DEPTH
    try {
      g('init', '-b', 'main')
      g('config', 'user.email', 'orch-test@example.invalid')
      g('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked.txt'), 'base\n')
      g('add', '.')
      g('commit', '-m', 'base')
      scriptedTransport([{ kind: 'completed', output: 'must not start' }]).install()
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
      if (oldDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = oldDepth
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
