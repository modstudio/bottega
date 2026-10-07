import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dir } from '../../test/preload.ts'
import { applyMigrations } from '../database/migrations.ts'

const hook = resolve(import.meta.dir, '../../hooks/git-guard.py')
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(dir, 'git-guard-'))
  fixtureRoots.push(root)
  const project = join(root, 'project')
  const worktree = join(project, '.claude', 'worktrees', 'DEV-1165')
  const outside = join(root, 'outside')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(outside)

  const databasePath = join(root, 'orch.db')
  const database = new Database(databasePath, { create: true })
  applyMigrations(database)
  database
    .query('INSERT INTO project (name,path,settings) VALUES (?,?,?)')
    .run(
      'fixture',
      project,
      JSON.stringify({ trunk: 'landing', productionBranch: 'production-live' }),
    )
  database.close()
  return { databasePath, outside, project, worktree }
}

function invoke(databasePath: string, cwd: string, command: string) {
  const result = Bun.spawnSync(['python3', hook], {
    env: { ...process.env, ORCH_DB: databasePath },
    stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: '',
  })
  const output = result.stdout.toString().trim()
  return output
    ? (JSON.parse(output).hookSpecificOutput as {
        permissionDecision: 'allow' | 'ask'
        permissionDecisionReason: string
      })
    : null
}

describe('git guard', () => {
  test('allows git directly and through workflow exec in a registered worktree', () => {
    const { databasePath, outside, worktree } = fixture()
    expect(invoke(databasePath, worktree, 'git status')?.permissionDecision).toBe('allow')
    expect(
      invoke(
        databasePath,
        outside,
        `/usr/local/bin/orch workflow exec -- git -C ${worktree} status`,
      )?.permissionDecision,
    ).toBe('allow')
    expect(
      invoke(databasePath, outside, `orch workflow exec --cwd ${worktree} -- git status`)
        ?.permissionDecision,
    ).toBe('allow')
  })

  test('asks for force pushes directly and through workflow exec', () => {
    const { databasePath, worktree } = fixture()
    expect(
      invoke(databasePath, worktree, 'git push --force origin feature:feature')?.permissionDecision,
    ).toBe('ask')
    expect(
      invoke(
        databasePath,
        worktree,
        'orch workflow exec -- git push --force origin feature:feature',
      )?.permissionDecision,
    ).toBe('ask')
  })

  test('allows scoped cleanup only for ordinary named branches', () => {
    const { databasePath, worktree } = fixture()
    expect(
      invoke(databasePath, worktree, 'git push --force-with-lease origin feature:feature')
        ?.permissionDecision,
    ).toBe('allow')
    expect(
      invoke(databasePath, worktree, 'git push --delete origin hotfix/x')?.permissionDecision,
    ).toBe('allow')
    for (const branch of ['landing', 'production-live']) {
      expect(
        invoke(databasePath, worktree, `git push --delete origin ${branch}`)?.permissionDecision,
      ).toBe('ask')
    }
  })

  test('falls through outside registered worktrees and for ambiguous commands', () => {
    const { databasePath, outside, worktree } = fixture()
    expect(invoke(databasePath, outside, 'git status')).toBeNull()
    expect(invoke(databasePath, worktree, 'orch workflow exec -- printf nope')).toBeNull()
    expect(invoke(databasePath, worktree, 'git status && git clean -fd')).toBeNull()
  })
})
