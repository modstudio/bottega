import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../database/migrations.ts'
import { CLI_COMMANDS } from './args.ts'
import { isHelpShapedInvocation, isStoreFreeInvocation } from './orch.ts'
import { program } from './program.ts'

test('the outer CLI classifies every informational invocation without consulting the store', () => {
  for (const argv of [
    [],
    ['help'],
    ['--help'],
    ['-h'],
    ['jobs', '--help'],
    ['jobs', '-h'],
    ['--version'],
  ]) {
    expect(isHelpShapedInvocation(argv)).toBeTrue()
  }
  expect(isHelpShapedInvocation(['jobs'])).toBeFalse()
  expect(isStoreFreeInvocation(['setup', 'facts', '--json'])).toBeTrue()
  expect(isStoreFreeInvocation(['setup'])).toBeFalse()
})

test('canon command recognition is pinned to the Commander registry', () => {
  const registered = new Set([
    'init-db',
    ...program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
  ])
  expect([...CLI_COMMANDS].sort()).toEqual([...registered].sort())
})

test('probe is listed with a one-line description', () => {
  const probe = program.commands.find((command) => command.name() === 'probe')
  expect(probe?.description()).toBe('clear a vendor-quota exclusion once the agent answers')
})

test('setup facts is store-free at the executable entry boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-setup-facts-entry-'))
  const absent = join(root, 'empty', 'orch.db')
  const existing = join(root, 'existing.db')
  const fixture = new Database(existing, { create: true })
  applyMigrations(fixture)
  const countsBefore = Object.fromEntries(
    (
      fixture
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map(({ name }) => [
      name,
      (fixture.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count,
    ]),
  )
  fixture.close()
  const run = (store: string) =>
    Bun.spawnSync(
      ['bun', '--no-env-file', join(import.meta.dir, 'orch.ts'), 'setup', 'facts', '--json'],
      {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          ...process.env,
          ORCH_DB: store,
          CLAUDE_CODE_SESSION_ID: 'setup-facts-store-free-test',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      },
    )
  try {
    const emptyResult = run(absent)
    expect(emptyResult.exitCode, emptyResult.stderr.toString()).toBe(0)
    expect(JSON.parse(emptyResult.stdout.toString()).os).toBeDefined()
    expect(existsSync(absent)).toBe(false)
    expect(existsSync(join(root, 'empty')) ? readdirSync(join(root, 'empty')) : []).toEqual([])

    const existingResult = run(existing)
    expect(existingResult.exitCode, existingResult.stderr.toString()).toBe(0)
    const observed = new Database(existing, { readonly: true })
    try {
      const countsAfter = Object.fromEntries(
        Object.keys(countsBefore).map((name) => [
          name,
          (observed.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number })
            .count,
        ]),
      )
      expect(countsAfter).toEqual(countsBefore)
    } finally {
      observed.close()
    }

    const bareSetup = Bun.spawnSync(
      ['bun', '--no-env-file', join(import.meta.dir, 'orch.ts'), 'setup'],
      {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          ...process.env,
          ORCH_DB: existing,
          ORCH_DB_WRITE: '1',
          CLAUDE_CODE_SESSION_ID: 'setup-non-tty-test',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      },
    )
    expect(bareSetup.exitCode).toBe(2)
    expect(bareSetup.stderr.toString()).toContain('requires both stdin and stdout to be TTYs')
    expect(bareSetup.stderr.toString()).toContain('orch setup apply --yes')
    expect(bareSetup.stderr.toString()).toContain('orch setup apply --answers <file>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
