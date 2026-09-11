import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bootstrapFixtureStore, dir, hermeticGitEnv, missingDatabaseMessage, projectAt, registeredRepositoryMissingDatabase, resolveDatabase, resolveRunsDirectory, stackAt, upsertProject } from '../fixture.ts'
describe('projects are data, not code', () => {

  test('init-db is the explicit creation path and refuses an existing database', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-init-db-'))
    const copy = join(root, 'main')
    const fresh = join(root, 'orchestrator', 'orch.db')
    const sourceRoot = join(dirname(new URL(import.meta.url).pathname), '../../..')
    mkdirSync(join(copy, 'orchestrator'), { recursive: true })
    cpSync(join(sourceRoot, 'orchestrator', 'src'), join(copy, 'orchestrator', 'src'), { recursive: true })
    cpSync(join(sourceRoot, 'orchestrator', 'migrations'), join(copy, 'orchestrator', 'migrations'), { recursive: true })
    cpSync(join(sourceRoot, 'shared'), join(copy, 'shared'), { recursive: true })
    symlinkSync(join(sourceRoot, 'orchestrator', 'node_modules'), join(copy, 'orchestrator', 'node_modules'))
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    git(copy, 'init', '-b', 'main')
    git(copy, 'config', 'user.email', 'orch-test@example.invalid')
    git(copy, 'config', 'user.name', 'Orch Test')
    git(copy, 'add', '.')
    git(copy, 'commit', '-m', 'DEV-321 main-checkout init-db')
    const entry = join(copy, 'orchestrator', 'src', 'orch.ts')
    const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], {
      cwd: copy, env: { ...hermeticGitEnv(), ORCH_DB: fresh, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const created = invoke('init-db')
      expect(created.exitCode, created.stderr.toString()).toBe(0)
      expect(created.stdout.toString()).toContain(fresh)
      expect(existsSync(fresh)).toBe(true)
      const second = invoke('init-db')
      expect(second.exitCode).not.toBe(0)
      expect(second.stderr.toString()).toContain(`already exists: ${fresh}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('normal commands refuse a missing override without creating it', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-missing-db-'))
    const fresh = join(root, 'missing.db')
    const entry = new URL('../../src/orch.ts', import.meta.url).pathname
    try {
      const result = Bun.spawnSync([process.execPath, entry, 'runs', '--limit', '1'], {
        env: { ...hermeticGitEnv(), ORCH_DB: fresh, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain(`database does not exist: ${fresh}`)
      expect(result.stderr.toString()).toContain('orch init-db')
      expect(existsSync(fresh)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
