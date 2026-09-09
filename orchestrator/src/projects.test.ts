import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbNameFor, hermeticGitEnv, recipeNotes, runRecipe } from '../test/fixture.ts'
import { provisionDb } from './recipe.ts'
import {
  MAIN_CHECKOUT_INVARIANT, assertMainCheckoutClean, inspectMainCheckout, mainCheckoutWorktreeHint,
  undeclaredCommitHooks, validateProjectSettings, validateStoredProjectSettings,
} from './projects.ts'

const CLEAN = { dirtyTracked: [] as string[], untracked: [] as string[], sequence: { status: 'none' as const } }

describe('a project can declare a worktree instead of writing one', () => {
  test('MCP server and probe declarations have actionable narrow shapes', () => {
    expect(validateProjectSettings({ mcpServer: 'project', mcp: { probe_tool: 'task.list' } }))
      .toEqual([])
    expect(validateProjectSettings({ mcpServer: '  ', mcp: { probe_tool: 'task list' } }))
      .toEqual([
        'mcpServer must be a non-empty string',
        'mcp.probe_tool must be a plain non-empty tool name',
      ])
  })

  test('stored legacy create is tolerated without hiding malformed MCP declarations', () => {
    expect(validateStoredProjectSettings({
      worktree: { create: 'scripts/worktree create {branch}' } as any,
      mcpServer: 'project', mcp: { probe_tool: 'task.list' },
    })).toEqual([])
    expect(validateStoredProjectSettings({
      worktree: { create: 'scripts/worktree create {branch}' } as any,
      mcpServer: ' ', mcp: { probe_tool: 'task list' },
    })).toEqual([
      'mcpServer must be a non-empty string',
      'mcp.probe_tool must be a plain non-empty tool name',
    ])
  })
  test('a derived database name is safe for both engines', () => {
    // Postgres folds unquoted identifiers to lower case and MySQL forbids most
    // punctuation, so the safe intersection is what this must produce — a name
    // needing quotes is a name that will one day be used unquoted.
    expect(dbNameFor('Star-Ship', 42)).toBe('star_ship_wt_42')
    expect(dbNameFor('my.app', 7)).toBe('my_app_wt_7')
    expect(dbNameFor('', 1)).toBe('app_wt_1')
    expect(dbNameFor('--weird--', 9)).toBe('weird_wt_9')
  })

  test('a recipe stops at its first failure and reports which step', () => {
    // A half-provisioned tree is the worst outcome available: a worker runs the
    // suite in it, the suite passes against nothing, and the run comes back
    // green. So the steps after a failure must not run.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    const steps = runRecipe(
      { install: 'exit 3', migrate: 'touch SHOULD-NOT-EXIST' }, dir, 'db_wt_1', '',
    )
    expect(steps.at(-1)!.ok).toBe(false)
    expect(steps.at(-1)!.step).toBe('install')
    expect(existsSync(join(dir, 'SHOULD-NOT-EXIST'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the env file is appended, so an inherited one survives', () => {
    // These files inherit the checkout's and add a managed block. Most loaders
    // are last-wins, which is what makes the inheritance safe rather than a
    // source of silent disagreement — so the generated block must come last and
    // must not replace what was there.
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    writeFileSync(join(dir, '.env'), 'INHERITED=yes\n')
    runRecipe({ env: { path: '.env', contents: 'DB={db}' } }, dir, 'db_wt_5', '')
    const out = readFileSync(join(dir, '.env'), 'utf8')
    expect(out).toContain('INHERITED=yes')
    expect(out.indexOf('DB=db_wt_5')).toBeGreaterThan(out.indexOf('INHERITED=yes'))
    rmSync(dir, { recursive: true, force: true })
  })

  test('a worker is warned off somebody else\'s server', () => {
    // The failure this exists to prevent does not announce itself: borrowing a
    // running server tests a different branch's bundle and PASSES.
    const notes = recipeNotes({ serve: 'bun dev --port {port}', database: { kind: 'none' } }, 'x', '8080')
    expect(notes).toContain('NEVER verify against a server you did not start')
    expect(notes).toContain('8080')
  })

  test('a SQL restore that exits 0 without readable counts is a failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recipe-restore-'))
    const mysql = join(dir, 'mysql')
    writeFileSync(mysql, '#!/bin/sh\nexit 0\n')
    chmodSync(mysql, 0o755)
    writeFileSync(join(dir, 'dump.sql'), 'SELECT 1;\n')
    const steps = provisionDb(
      { kind: 'mysql-dump', dump: join(dir, 'dump.sql'), mysql }, 'app_wt_1', dir,
    )
    expect(steps.at(-1)!.ok).toBe(false)
    expect(steps.at(-1)!.detail).toContain('counts were not readable')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a SQL restore records table and constraint counts after load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recipe-restore-ok-'))
    const mysql = join(dir, 'mysql')
    writeFileSync(mysql, '#!/bin/sh\necho "4 9"\nexit 0\n')
    chmodSync(mysql, 0o755)
    writeFileSync(join(dir, 'dump.sql'), 'SELECT 1;\n')
    const steps = provisionDb(
      { kind: 'mysql-dump', dump: join(dir, 'dump.sql'), mysql }, 'app_wt_1', dir,
    )
    expect(steps.at(-1)).toMatchObject({ ok: true, detail: '4 tables, 9 constraints' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('an empty recipe is plain git, which is right where a checkout is just files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recipe-'))
    expect(runRecipe({}, dir, 'db_wt_1', '')).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('commit hook cost', () => {
  test('doctor flags a project whose gate declares nothing while hooks carry pre-commit checks', () => {
    const path = mkdtempSync(join(tmpdir(), 'orch-hooks-gate-'))
    const hooks = join(path, '.githooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(hooks, 'commit-msg'), 0o755)
    const project = {
      id: 1, name: 'hooks-project', path, stack: null, canon: false, settings: {},
    }
    expect(undeclaredCommitHooks(project)).toContain('gate undeclared')
    expect(undeclaredCommitHooks({ ...project, settings: { gate: 'bun test' } })).toBeNull()
    rmSync(path, { recursive: true, force: true })
  })
})

describe('main checkout cleanliness', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const scratch = () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-main-clean-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n')
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
    return repo
  }
  const project = (repo: string, settings: Record<string, unknown> = {}) => ({
    id: 1, name: 'clean-main', path: repo, stack: null, canon: false, settings,
  })

  test('requireCleanMain must be a boolean when declared', () => {
    expect(validateProjectSettings({ requireCleanMain: false })).toEqual([])
    expect(validateProjectSettings({ requireCleanMain: true })).toEqual([])
    expect(validateProjectSettings({ requireCleanMain: 'false' as any }))
      .toEqual(['requireCleanMain must be a boolean'])
  })

  test('a clean checkout is silent', () => {
    const repo = scratch()
    try {
      expect(inspectMainCheckout(repo)).toEqual(CLEAN)
      expect(assertMainCheckoutClean(project(repo))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a tracked modification refuses, names the path, and carries both anchored lines', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'dirty\n')
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: ['tracked.txt'], untracked: [], sequence: { status: 'none' },
      })
      expect(() => assertMainCheckoutClean(project(repo))).toThrow(MAIN_CHECKOUT_INVARIANT)
      try {
        assertMainCheckoutClean(project(repo))
      } catch (error) {
        const text = String(error)
        expect(text).toContain(`main checkout ${repo} has tracked modifications: tracked.txt`)
        expect(text).toContain(`work from a worktree under ${mainCheckoutWorktreeHint(repo)} instead`)
        expect(text).toMatch(/^invariant: .+$/m)
        expect(text).toContain(`cleared by: orch do --cwd '${mainCheckoutWorktreeHint(repo)}/<tree>'`)
        expect(text).not.toContain('stash')
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a dirty path with spaces and command substitution is not interpolated into cleared-by', () => {
    const repo = scratch()
    try {
      const nasty = '$(touch pwned) and space.txt'
      writeFileSync(join(repo, nasty), 'fixture\n')
      git(repo, 'add', nasty)
      git(repo, 'commit', '-m', 'nasty')
      writeFileSync(join(repo, nasty), 'dirty\n')
      try {
        assertMainCheckoutClean(project(repo))
        throw new Error('expected refusal')
      } catch (error) {
        const text = String(error)
        const hint = mainCheckoutWorktreeHint(repo)
        const cleared = text.split('\n').find((line) => line.startsWith('cleared by:'))
        expect(text).toContain(nasty)
        expect(cleared).toBe(`cleared by: orch do --cwd '${hint}/<tree>'`)
        expect(cleared).not.toContain('stash')
        expect(cleared).not.toContain('$(touch pwned)')
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an untracked file warns and does not refuse', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'scratch.db'), 'untracked\n')
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: [], untracked: ['scratch.db'], sequence: { status: 'none' },
      })
      expect(assertMainCheckoutClean(project(repo))).toContain('scratch.db')
      expect(assertMainCheckoutClean(project(repo))).toContain('they do not block dispatch')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an ignored file is silent', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'ignored.txt'), 'ignored\n')
      expect(inspectMainCheckout(repo)).toEqual(CLEAN)
      expect(assertMainCheckoutClean(project(repo))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a project with the exemption declared is clean while dirty', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'dirty\n')
      expect(assertMainCheckoutClean(project(repo, { requireCleanMain: false }))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a registered subdirectory of a git checkout is not a main checkout', () => {
    const repo = scratch()
    const nested = join(repo, 'nested')
    try {
      mkdirSync(nested)
      expect(inspectMainCheckout(nested)).toBeNull()
      expect(assertMainCheckoutClean(project(nested))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a stale mtime without a content change reports clean', () => {
    const repo = scratch()
    try {
      utimesSync(join(repo, 'tracked.txt'), 1, 1)
      const stale = Bun.spawnSync(
        ['git', '-C', repo, 'diff-index', '--quiet', 'HEAD', '--'],
        { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
      )
      expect(stale.exitCode).toBe(1)
      expect(inspectMainCheckout(repo)).toEqual(CLEAN)
      expect(assertMainCheckoutClean(project(repo))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('inspection does not write a foreign GIT_INDEX_FILE', () => {
    const repo = scratch()
    const tree = join(tmpdir(), `orch-sibling-tree-${Date.now()}`)
    const previous = process.env.GIT_INDEX_FILE
    try {
      git(repo, 'worktree', 'add', '-b', 'sibling', tree, 'main')
      const siblingIndex = git(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
      const before = createHash('sha256').update(readFileSync(siblingIndex)).digest('hex')
      utimesSync(join(repo, 'tracked.txt'), 1, 1)
      process.env.GIT_INDEX_FILE = siblingIndex
      expect(inspectMainCheckout(repo)).toEqual(CLEAN)
      expect(assertMainCheckoutClean(project(repo))).toBeNull()
      expect(createHash('sha256').update(readFileSync(siblingIndex)).digest('hex')).toBe(before)
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = previous
      rmSync(tree, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unrunnable git is indeterminate and fails open', () => {
    const repo = scratch()
    const empty = mkdtempSync(join(tmpdir(), 'orch-empty-path-'))
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'dirty\n')
      const child = Bun.spawnSync(
        [process.execPath, '--eval', `
          const { inspectMainCheckout, assertMainCheckoutClean } = await import(${JSON.stringify(new URL('./projects.ts', import.meta.url).href)});
          const repo = ${JSON.stringify(repo)};
          let threw = false;
          let inspection;
          let asserted;
          try {
            inspection = inspectMainCheckout(repo);
            asserted = assertMainCheckoutClean({
              id: 1, name: 'clean-main', path: repo, stack: null, canon: false, settings: {},
            });
          } catch (error) {
            threw = true;
            asserted = String(error);
          }
          process.stdout.write(JSON.stringify({ threw, inspection, asserted }));
        `],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: empty } },
      )
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const body = JSON.parse(child.stdout.toString()) as {
        threw: boolean
        inspection: unknown
        asserted: unknown
      }
      expect(body.threw).toBe(false)
      expect(body.inspection).toBeNull()
      expect(body.asserted).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a dummy index.lock with a genuinely dirty file still reports dirty', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'dirty\n')
      writeFileSync(join(repo, '.git', 'index.lock'), '')
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: ['tracked.txt'], untracked: [], sequence: { status: 'none' },
      })
      expect(() => assertMainCheckoutClean(project(repo))).toThrow(MAIN_CHECKOUT_INVARIANT)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a cleanliness check does not write the index: the obvious command writes, and the fast command lies about stat', () => {
    const repo = scratch()
    try {
      utimesSync(join(repo, 'tracked.txt'), 1, 1)
      const index = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
      const before = createHash('sha256').update(readFileSync(index)).digest('hex')
      const beforeStat = statSync(index)
      expect(inspectMainCheckout(repo)).toEqual(CLEAN)
      expect(createHash('sha256').update(readFileSync(index)).digest('hex')).toBe(before)
      const afterStat = statSync(index)
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
      expect(afterStat.size).toBe(beforeStat.size)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a staged-only tracked change refuses', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'staged\n')
      git(repo, 'add', 'tracked.txt')
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: ['tracked.txt'], untracked: [], sequence: { status: 'none' },
      })
      expect(() => assertMainCheckoutClean(project(repo))).toThrow(MAIN_CHECKOUT_INVARIANT)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a staged new file is tracked dirt, not an untracked warning', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'added.txt'), 'staged addition\n')
      git(repo, 'add', 'added.txt')
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: ['added.txt'], untracked: [], sequence: { status: 'none' },
      })
      expect(() => assertMainCheckoutClean(project(repo))).toThrow(MAIN_CHECKOUT_INVARIANT)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an in-progress no-commit merge over a clean tree refuses and names merge --abort', () => {
    const repo = scratch()
    try {
      git(repo, 'checkout', '-b', 'topic')
      git(repo, 'commit', '--allow-empty', '-m', 'empty topic')
      git(repo, 'checkout', 'main')
      const merge = Bun.spawnSync(
        ['git', 'merge', '--no-ff', '--no-commit', 'topic'],
        { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
      )
      expect(merge.exitCode, merge.stderr.toString()).toBe(0)
      const inspection = inspectMainCheckout(repo)
      expect(inspection?.dirtyTracked).toEqual([])
      expect(inspection?.sequence).toEqual({ status: 'in-progress', kind: 'merge' })
      try {
        assertMainCheckoutClean(project(repo))
        throw new Error('expected refusal')
      } catch (error) {
        const text = String(error)
        expect(text).toContain('in-progress merge')
        expect(text).toContain(`cleared by: git -C '${repo}' merge --abort`)
        expect(text).not.toContain('cherry-pick --abort')
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('an in-progress no-commit merge with a staged addition is still classified by git as a merge', () => {
    const repo = scratch()
    try {
      git(repo, 'checkout', '-b', 'topic')
      git(repo, 'commit', '--allow-empty', '-m', 'empty topic')
      git(repo, 'checkout', 'main')
      git(repo, 'merge', '--no-ff', '--no-commit', 'topic')
      writeFileSync(join(repo, 'added.txt'), 'staged addition\n')
      git(repo, 'add', 'added.txt')
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: ['added.txt'], untracked: [], sequence: { status: 'in-progress', kind: 'merge' },
      })
      expect(() => assertMainCheckoutClean(project(repo))).toThrow('in-progress merge')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('revert --no-commit is in-progress', () => {
    const repo = scratch()
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'change to revert\n')
      git(repo, 'commit', '-am', 'change')
      git(repo, 'revert', '--no-commit', 'HEAD')
      expect(inspectMainCheckout(repo)?.sequence).toEqual({ status: 'in-progress', kind: 'revert' })
      expect(() => assertMainCheckoutClean(project(repo))).toThrow('revert --abort')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a leftover CHERRY_PICK_HEAD over a clean tree is residue and does not refuse', () => {
    const repo = scratch()
    try {
      const sha = git(repo, 'rev-parse', 'HEAD')
      writeFileSync(join(repo, '.git', 'CHERRY_PICK_HEAD'), `${sha}\n`)
      expect(inspectMainCheckout(repo)).toEqual({
        dirtyTracked: [], untracked: [], sequence: { status: 'residue', kind: 'cherry-pick' },
      })
      expect(assertMainCheckoutClean(project(repo))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('a rebase-merge directory refuses and names rebase --abort', () => {
    const repo = scratch()
    try {
      const dir = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')
      mkdirSync(dir)
      expect(inspectMainCheckout(repo)?.sequence).toEqual({ status: 'in-progress', kind: 'rebase' })
      try {
        assertMainCheckoutClean(project(repo))
        throw new Error('expected refusal')
      } catch (error) {
        const text = String(error)
        expect(text).toContain('in-progress rebase')
        expect(text).toContain(`cleared by: git -C '${repo}' rebase --abort`)
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('bisect with a clean tree refuses and names bisect reset', () => {
    const repo = scratch()
    try {
      git(repo, 'bisect', 'start')
      expect(inspectMainCheckout(repo)?.sequence).toEqual({ status: 'in-progress', kind: 'bisect' })
      try {
        assertMainCheckoutClean(project(repo))
        throw new Error('expected refusal')
      } catch (error) {
        const text = String(error)
        expect(text).toContain('in-progress bisect')
        expect(text).toContain(`cleared by: git -C '${repo}' bisect reset`)
        expect(text).not.toContain('--abort')
      }
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  test('hostile GIT_DIR and GIT_INDEX_FILE still answer about the named tree', () => {
    const repo = scratch()
    const other = scratch()
    const previousDir = process.env.GIT_DIR
    const previousIndex = process.env.GIT_INDEX_FILE
    try {
      writeFileSync(join(other, 'tracked.txt'), 'other-dirty\n')
      git(other, 'add', 'tracked.txt')
      git(other, 'commit', '-m', 'other')
      process.env.GIT_DIR = git(other, 'rev-parse', '--path-format=absolute', '--git-dir')
      process.env.GIT_INDEX_FILE = git(other, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
      expect(inspectMainCheckout(repo)).toEqual(CLEAN)
      expect(inspectMainCheckout(other)).toEqual(CLEAN)
    } finally {
      if (previousDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousDir
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = previousIndex
      rmSync(repo, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })
})
