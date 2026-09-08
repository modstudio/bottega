import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbNameFor, recipeNotes, runRecipe } from '../test/fixture.ts'
import { provisionDb } from './recipe.ts'
import { undeclaredCommitHooks, validateProjectSettings, validateStoredProjectSettings } from './projects.ts'

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
