import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { bootstrapFixtureStore, dir, hermeticGitEnv, missingDatabaseMessage, projectAt, registeredRepositoryMissingDatabase, resolveDatabase, resolveRunsDirectory, stackAt, upsertProject } from '../test/fixture.ts'

describe('projects are data, not code', () => {
  test('database resolution honors an explicit override', () => {
    const path = join(dir, 'explicit-resolution.db')
    expect(resolveDatabase('/outside', { ORCH_DB: path }, '/main/orchestrator')).toMatchObject({
      path, method: 'ORCH_DB', tried: [path],
    })
  })

  test('database resolution follows a linked worktree to its git common directory', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-location-')))
    const tree = join(repo, 'tree')
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked'), 'fixture\n')
      git(repo, 'add', 'tracked')
      git(repo, 'commit', '-m', 'fixture')
      git(repo, 'worktree', 'add', '-b', 'test-tree', tree, 'main')
      mkdirSync(join(repo, 'orchestrator'))
      const path = join(repo, 'orchestrator', 'orch.db')
      writeFileSync(path, 'fixture')
      expect(resolveDatabase(tree, {}, '/work/.claude/worktrees/local/orchestrator')).toMatchObject({
        path, method: 'git-common-dir', tried: [path],
      })
      expect(existsSync(join(tree, 'orchestrator', 'orch.db'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unreadable common directory is recovered from the linked worktree pointer for either binary', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-pointer-')))
    const tree = join(repo, 'tree')
    const databasePath = join(repo, 'orchestrator', 'orch.db')
    const override = join(repo, 'override.db')
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked'), 'fixture\n')
      git(repo, 'add', 'tracked')
      git(repo, 'commit', '-m', 'fixture')
      git(repo, 'worktree', 'add', '-b', 'test-tree', tree, 'main')
      mkdirSync(join(repo, 'orchestrator'))
      writeFileSync(databasePath, 'fixture')
      chmodSync(join(repo, '.git'), 0o000)

      for (const binaryRoot of [
        join(repo, 'orchestrator'),
        join(repo, '.claude', 'worktrees', 'local', 'orchestrator'),
      ]) {
        expect(resolveDatabase(tree, {}, binaryRoot)).toMatchObject({
          path: databasePath, method: 'git-pointer',
        })
        expect(resolveDatabase(tree, { ORCH_DB: override }, binaryRoot)).toMatchObject({
          path: override, method: 'ORCH_DB',
        })
      }
    } finally {
      chmodSync(join(repo, '.git'), 0o755)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a sibling repository with no database falls through to the main binary database', () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-sibling-')))
    const sibling = join(main, 'sibling')
    const binaryRoot = join(main, 'orchestrator')
    try {
      mkdirSync(sibling)
      for (const cwd of [main, sibling]) {
        const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
          cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        expect(initialized.exitCode).toBe(0)
      }
      mkdirSync(binaryRoot)
      const candidate = join(sibling, 'orchestrator', 'orch.db')
      expect(resolveDatabase(sibling, {}, binaryRoot)).toMatchObject({
        path: join(binaryRoot, 'orch.db'), method: 'binary-relative',
        tried: [candidate, join(binaryRoot, 'orch.db')],
      })
    } finally {
      rmSync(main, { recursive: true, force: true })
    }
  })

  test('a missing database in this source repository is retained for refusal and main-only initialization', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-own-missing-')))
    const tree = join(repo, 'tree')
    const candidate = join(repo, 'orchestrator', 'orch.db')
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked'), 'fixture\n')
      git(repo, 'add', 'tracked')
      git(repo, 'commit', '-m', 'fixture')
      git(repo, 'worktree', 'add', '-b', 'test-tree', tree, 'main')
      mkdirSync(join(repo, 'orchestrator'))
      mkdirSync(join(tree, 'orchestrator'))

      const main = resolveDatabase(repo, {}, join(repo, 'orchestrator'))
      expect(main).toMatchObject({ path: candidate, initializable: true })
      expect(missingDatabaseMessage(main.path)).toContain(`database does not exist: ${candidate}`)

      chmodSync(join(repo, '.git'), 0o000)
      const worktree = resolveDatabase(tree, {}, join(tree, 'orchestrator'))
      expect(worktree).toMatchObject({ path: candidate, method: 'git-pointer', initializable: false })
      expect(missingDatabaseMessage(worktree.path)).toContain(candidate)
    } finally {
      chmodSync(join(repo, '.git'), 0o755)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a bare repository is its own root and never borrows its parent database', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-bare-')))
    const main = join(parent, 'main')
    const bare = join(parent, 'repository.git')
    const binaryRoot = join(main, 'orchestrator')
    const wrong = join(parent, 'orchestrator', 'orch.db')
    const right = join(bare, 'orchestrator', 'orch.db')
    try {
      mkdirSync(main)
      const mainInitialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
        cwd: main, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(mainInitialized.exitCode).toBe(0)
      const initialized = Bun.spawnSync(['git', 'init', '--bare', bare], {
        env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      expect(initialized.exitCode).toBe(0)
      mkdirSync(dirname(wrong), { recursive: true })
      writeFileSync(wrong, 'wrong database')
      const absent = resolveDatabase(bare, {}, binaryRoot)
      expect(absent).toMatchObject({
        path: join(binaryRoot, 'orch.db'), method: 'binary-relative',
        tried: [right, join(binaryRoot, 'orch.db')],
      })
      expect(absent.path).not.toBe(wrong)
      mkdirSync(dirname(right), { recursive: true })
      writeFileSync(right, 'right database')
      expect(resolveDatabase(bare, {}, '/work/.claude/worktrees/local/orchestrator'))
        .toMatchObject({ path: right, method: 'git-common-dir' })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('the opened register can identify a missing platform database after pre-open fallback', () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-register-')))
    const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
      cwd: main, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    expect(initialized.exitCode).toBe(0)
    mkdirSync(join(main, 'orchestrator'))
    const resolution = {
      ...resolveDatabase('/outside', {}, join(main, 'orchestrator')),
      repositoryRoot: '/registered/platform',
      repositoryCandidate: '/registered/platform/orchestrator/orch.db',
      repositoryCandidateExisted: false,
    }
    expect(registeredRepositoryMissingDatabase(resolution, '/registered/platform'))
      .toBe('/registered/platform/orchestrator/orch.db')
    expect(registeredRepositoryMissingDatabase(resolution, '/another/platform')).toBeNull()
    rmSync(main, { recursive: true, force: true })
  })

  test('runs and pending use the main database from a linked worktree without an override', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-cli-')))
    const tree = join(repo, '.claude', 'worktrees', 'test-tree')
    const databasePath = join(repo, 'orchestrator', 'orch.db')
    const entry = new URL('orch.ts', import.meta.url).pathname
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked'), 'fixture\n')
      git(repo, 'add', 'tracked')
      git(repo, 'commit', '-m', 'fixture')
      bootstrapFixtureStore(databasePath)
      const fixture = new Database(databasePath)
      fixture.query('INSERT INTO project (name,path,stack,canon,settings) VALUES (?,?,?,?,?)')
        .run(PLATFORM_SLUG, repo, 'typescript', 1, '{}')
      const id = (fixture.query(
        `INSERT INTO run (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,session_id)
         VALUES (?,'codex','implement','x',1,'x','ok','db-resolution-session') RETURNING id`,
      ).get(new Date().toISOString()) as { id: number }).id
      fixture.close()
      git(repo, 'worktree', 'add', '-b', 'test-tree', tree, 'main')

      const childEnv: Record<string, string | undefined> = {
        ...hermeticGitEnv(), CLAUDE_CODE_SESSION_ID: 'db-resolution-session',
      }
      delete childEnv.ORCH_DB
      delete childEnv.ORCH_RUNS
      const runs = Bun.spawnSync([process.execPath, entry, 'runs', '--limit', '1'], {
        cwd: tree, env: childEnv, stdout: 'pipe', stderr: 'pipe',
      })
      expect(runs.exitCode).toBe(0)
      expect(runs.stdout.toString()).toContain(String(id))
      const pending = Bun.spawnSync([process.execPath, entry, 'pending'], {
        cwd: tree, env: childEnv, stdout: 'pipe', stderr: 'pipe',
      })
      expect(pending.exitCode).toBe(1)
      expect(pending.stdout.toString()).toContain(String(id))
      expect(existsSync(join(tree, 'orchestrator', 'orch.db'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('an externally located linked binary resolves main and may never initialize beside itself', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'orch-db-external-binary-')))
    const main = join(parent, 'main')
    const tree = join(parent, 'external-linked')
    const mainRoot = join(main, 'orchestrator')
    const binaryRoot = join(tree, 'orchestrator')
    const databasePath = join(mainRoot, 'orch.db')
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    try {
      mkdirSync(main)
      git(main, 'init', '-b', 'main')
      git(main, 'config', 'user.email', 'orch-test@example.invalid')
      git(main, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(main, 'tracked'), 'fixture\n')
      git(main, 'add', 'tracked')
      git(main, 'commit', '-m', 'fixture')
      git(main, 'worktree', 'add', '-b', 'external-tree', tree, 'main')
      mkdirSync(mainRoot)
      mkdirSync(binaryRoot)
      writeFileSync(databasePath, 'fixture')

      expect(resolveDatabase(parent, {}, mainRoot)).toMatchObject({
        path: databasePath, method: 'binary-relative', initializable: true,
      })
      expect(resolveDatabase(parent, {}, binaryRoot)).toMatchObject({
        path: databasePath, method: 'git-common-dir', initializable: false,
      })
      rmSync(databasePath)
      expect(() => resolveDatabase(parent, {}, binaryRoot))
        .toThrow(/main\/orchestrator\/orch\.db[\s\S]*external-linked\/orchestrator\/orch\.db[\s\S]*orch init-db/)
      expect(existsSync(join(binaryRoot, 'orch.db'))).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('run files live beside the resolved database unless explicitly overridden', () => {
    expect(resolveRunsDirectory({ path: '/main/orchestrator/orch.db' }, {})).toBe('/main/orchestrator/runs')
    expect(resolveRunsDirectory({ path: '/main/orchestrator/orch.db' }, { ORCH_RUNS: '/elsewhere/runs' }))
      .toBe('/elsewhere/runs')
  })

  test('init-db is the explicit creation path and refuses an existing database', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-init-db-'))
    const copy = join(root, 'main')
    const fresh = join(root, 'orchestrator', 'orch.db')
    const sourceRoot = join(dirname(new URL(import.meta.url).pathname), '../..')
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
    const entry = new URL('orch.ts', import.meta.url).pathname
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

  test('a directory belongs to the project that contains it', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', stack: 'php-laravel' })
    expect(projectAt('/w/alpha')?.name).toBe('alpha')
    expect(projectAt('/w/alpha/src/deep/file')?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt('/w/alpha/.claude/worktrees/orch-12')?.name).toBe('alpha')
    expect(stackAt('/w/alpha/.claude/worktrees/orch-12')).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('the longest matching path wins, so nesting resolves inward', () => {
    upsertProject({ name: 'outer', path: '/w' })
    upsertProject({ name: 'inner', path: '/w/inner' })
    expect(projectAt('/w/inner/src')?.name).toBe('inner')
    expect(projectAt('/w/other')?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    upsertProject({
      name: 'alpha', path: '/w/alpha',
      settings: { trunk: 'develop', states: { in_progress: 'active' } },
    })
    const p = projectAt('/w/alpha')!
    expect(p.settings.trunk).toBe('develop')
    expect(p.settings.states?.in_progress).toBe('active')
  })
})
