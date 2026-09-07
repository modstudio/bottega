import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ops launchd plists', () => {
  test('every ops launchd template lints after placeholder substitution', () => {
    const root = new URL('../../ops/launchd', import.meta.url).pathname
    const templates = readdirSync(root).filter((name) => name.endsWith('.plist.template'))
    expect(templates).toContain('com.user.orch-canon-eval.plist.template')
    const dir = mkdtempSync(join(tmpdir(), 'orch-plist-'))
    try {
      for (const name of templates) {
        const rendered = readFileSync(join(root, name), 'utf8')
          .replaceAll('__ROOT__', '/tmp/repo')
          .replaceAll('__REPO__', '/tmp/repo/ops')
          .replaceAll('__HOME__', '/tmp')
          .replaceAll('__MONITOR_BACKSTOP_SECONDS__', '14400')
          .replaceAll('__MODEL_HOST__', 'example')
        const path = join(dir, name.replace(/\.template$/, ''))
        writeFileSync(path, rendered)
        const lint = Bun.spawnSync(['plutil', '-lint', path], { stdout: 'pipe', stderr: 'pipe' })
        expect(lint.exitCode, name).toBe(0)
        expect(lint.stdout.toString() + lint.stderr.toString()).toContain('OK')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('install refuses to render launchd agents from a linked worktree', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-ops-install-'))
    const main = join(fixture, 'main')
    const linked = join(fixture, 'linked')
    const source = new URL('../../ops/install.sh', import.meta.url).pathname
    try {
      mkdirSync(join(main, 'ops'), { recursive: true })
      copyFileSync(source, join(main, 'ops/install.sh'))
      chmodSync(join(main, 'ops/install.sh'), 0o755)
      const git = (...args: string[]) => Bun.spawnSync(['git', ...args], {
        cwd: main, stdout: 'pipe', stderr: 'pipe',
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      })
      expect(git('init', '-b', 'main').exitCode).toBe(0)
      expect(git('config', 'user.email', 'ops-install@example.invalid').exitCode).toBe(0)
      expect(git('config', 'user.name', 'Ops Install Test').exitCode).toBe(0)
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
