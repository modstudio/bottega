import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { spawnFixtureGitSync, spawnFixtureSync } from '../../test/fixtures/spawn.ts'
import { dir } from '../../test/preload.ts'
import { writeMigratedTestDatabase } from '../database/test-database.fixture.ts'
import type { ProjectSettings } from '../project/projects.ts'

const cli = resolve(import.meta.dir, '../cli/orch.ts')
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureDirectory(prefix: string): string {
  const root = mkdtempSync(join(dir, prefix))
  fixtureRoots.push(root)
  return root
}

function registerProject(name: string, path: string, settings: ProjectSettings): string {
  const databasePath = join(fixtureDirectory('enabled-check-db-'), 'orchestrator.db')
  writeMigratedTestDatabase(databasePath)
  const database = new Database(databasePath)
  database
    .query(
      'INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?)',
    )
    .run(name, path, JSON.stringify(settings))
  database.close()
  return databasePath
}

function git(root: string, ...argv: string[]) {
  const result = spawnFixtureGitSync(argv, {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function repository(name: string, committed = false): string {
  const root = fixtureDirectory(`${name}-`)
  git(root, 'init', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'ordinary text\n')
  if (!committed) return root
  git(root, 'add', 'README.md')
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Initial fixture',
  )
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return root
}

function installTypos(): string {
  const bin = fixtureDirectory('enabled-check-bin-')
  const typos = join(bin, 'typos')
  writeFileSync(
    typos,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "typos-cli 1.50.0"; exit 0; fi\npwd > "$CHECK_SENTINEL"\n',
  )
  chmodSync(typos, 0o755)
  return bin
}

function installGh(): string {
  const bin = fixtureDirectory('enabled-check-gh-')
  const gh = join(bin, 'gh')
  writeFileSync(
    gh,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"title":"Generated with Codex","body":"ordinary"}\'\n',
  )
  chmodSync(gh, 0o755)
  return bin
}

describe(`${PLATFORM_SLUG} gate check --enabled`, () => {
  test('a project without attribution enabled skips pull request attribution', () => {
    const root = fixtureDirectory('checks-pr-')
    writeFileSync(join(root, 'README.md'), 'ordinary text\n')
    const gh = installGh()
    const database = registerProject('checks-pr-out', root, { trunk: 'main' })

    const result = spawnFixtureSync(
      [
        'bun',
        '--no-env-file',
        cli,
        'check',
        '--enabled',
        '--project',
        'checks-pr-out',
        '--pr',
        'https://example.test/pr/1',
      ],
      {
        env: {
          ...process.env,
          BOTTEGA_ORCHESTRATOR_DB: database,
          PATH: `${gh}:${process.env.PATH}`,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('no checks enabled for checks-pr-out')
  })

  test('an attribution opt-in checks the pull request', () => {
    const root = repository('checks-pr-in')
    const gh = installGh()
    const optedInDatabase = registerProject('checks-pr-in', root, {
      trunk: 'main',
      checks: { attribution: true },
    })

    const optedInResult = spawnFixtureSync(
      [
        'bun',
        '--no-env-file',
        cli,
        'check',
        '--enabled',
        '--project',
        'checks-pr-in',
        '--pr',
        'https://example.test/pr/1',
      ],
      {
        env: {
          ...process.env,
          BOTTEGA_ORCHESTRATOR_DB: optedInDatabase,
          PATH: `${gh}:${process.env.PATH}`,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(optedInResult.exitCode).toBe(1)
    expect(optedInResult.stdout.toString()).toContain('pr:1: Generated with Codex')
    expect(optedInResult.stdout.toString()).toContain('failed check: attribution')
  })

  test('both opt-ins run and name the failing check', () => {
    const root = repository('checks-both', true)
    const bin = installTypos()
    const sentinel = join(root, 'typos-ran')
    git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'Generated by AI',
    )
    const database = registerProject('checks-both', root, {
      trunk: 'main',
      checks: { spelling: true, attribution: true },
    })

    const result = spawnFixtureSync(
      ['bun', '--no-env-file', cli, 'check', '--enabled', '--project', 'checks-both'],
      {
        env: {
          ...process.env,
          BOTTEGA_ORCHESTRATOR_DB: database,
          PATH: `${bin}:${process.env.PATH}`,
          CHECK_SENTINEL: sentinel,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(1)
    expect(existsSync(sentinel)).toBe(true)
    expect(result.stdout.toString()).toContain('Generated by AI')
    expect(result.stdout.toString()).toContain('failed check: attribution')
    expect(result.stdout.toString()).not.toContain('failed check: spelling')
  })
})
