import { describe, expect, test } from 'bun:test'
import { cloneRepository } from '../fixtures/git.ts'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ops launchd install process boundary', () => {
  test('install refuses to render launchd agents from a linked worktree', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-ops-install-'))
    const main = cloneRepository('orch-ops-install-main-')
    const linked = join(fixture, 'linked')
    const source = new URL('../../../ops/install.sh', import.meta.url).pathname
    try {
      mkdirSync(join(main, 'ops'), { recursive: true })
      copyFileSync(source, join(main, 'ops/install.sh'))
      chmodSync(join(main, 'ops/install.sh'), 0o755)
      const git = (...args: string[]) => Bun.spawnSync(['git', ...args], {
        cwd: main, stdout: 'pipe', stderr: 'pipe',
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      })
      expect(git('add', 'ops/install.sh').exitCode).toBe(0)
      expect(git('commit', '-m', 'fixture').exitCode).toBe(0)
      expect(git('worktree', 'add', '-b', 'fixture-linked', linked).exitCode).toBe(0)

      const installed = Bun.spawnSync(['bash', join(linked, 'ops/install.sh')], {
        stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: join(fixture, 'home') },
      })
      expect(installed.exitCode).toBe(1)
      expect(installed.stderr.toString()).toContain(`linked worktree ${linked}`)
      expect(installed.stderr.toString()).toContain(`main checkout ${realpathSync(main)}`)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
