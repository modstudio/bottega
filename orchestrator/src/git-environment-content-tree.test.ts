import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { contentTree, hermeticGitEnv } from '../test/fixture.ts'
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
})
