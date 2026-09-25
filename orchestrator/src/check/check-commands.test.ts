import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnFixtureSync } from '../../test/fixtures/spawn.ts'
import { dir } from '../../test/preload.ts'
import { applyMigrations } from '../database/migrations.ts'
import type { ProjectSettings } from '../project/projects.ts'

const cli = resolve(import.meta.dir, '../cli/orch.ts')
const britishSample = readFileSync(
  join(import.meta.dir, 'fixtures/spelling-samples/british-samples.txt'),
  'utf8',
).trim()

function run(database: string, ...argv: string[]) {
  return spawnFixtureSync(['bun', '--no-env-file', cli, 'check', '--enabled', ...argv], {
    env: { ...process.env, ORCH_DB: database },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function registerProject(name: string, path: string, settings: ProjectSettings): string {
  const databasePath = join(mkdtempSync(join(dir, 'enabled-check-db-')), 'orch.db')
  const database = new Database(databasePath, { create: true })
  applyMigrations(database)
  database
    .query('INSERT INTO project (name,path,settings) VALUES (?,?,?)')
    .run(name, path, JSON.stringify(settings))
  database.close()
  return databasePath
}

function git(root: string, ...argv: string[]) {
  const result = spawnFixtureSync(['git', ...argv], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function repository(name: string, committed = false): string {
  const root = mkdtempSync(join(dir, `${name}-`))
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
  const bin = mkdtempSync(join(dir, 'enabled-check-bin-'))
  const typos = join(bin, 'typos')
  writeFileSync(
    typos,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "typos-cli 1.50.0"; exit 0; fi\npwd > "$CHECK_SENTINEL"\n',
  )
  chmodSync(typos, 0o755)
  return bin
}

function installGh(): string {
  const bin = mkdtempSync(join(dir, 'enabled-check-gh-'))
  const gh = join(bin, 'gh')
  writeFileSync(
    gh,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"title":"Generated with Codex","body":"ordinary"}\'\n',
  )
  chmodSync(gh, 0o755)
  return bin
}

describe('orch check --enabled', () => {
  test('an empty register opt-in succeeds and names the project', () => {
    const root = repository('checks-none')
    const database = registerProject('checks-none', root, { trunk: 'main' })

    const result = run(database, '--project', 'checks-none')

    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: '',
    })
    expect(result.stdout.toString().trim()).toBe('no checks enabled for checks-none')
  })

  test('a spelling-only opt-in runs typos', () => {
    const root = repository('checks-spelling', true)
    const bin = installTypos()
    const sentinel = join(root, 'typos-ran')
    const worktree = join(root, '.claude', 'worktrees', 'checks-spelling')
    mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true })
    git(root, 'worktree', 'add', '-b', 'checks-spelling-worktree', worktree)
    const database = registerProject('checks-spelling', root, {
      trunk: 'main',
      checks: { spelling: true },
    })

    const result = spawnFixtureSync(
      ['bun', '--no-env-file', cli, 'check', '--enabled', '--project', 'checks-spelling'],
      {
        env: {
          ...process.env,
          ORCH_DB: database,
          PATH: `${bin}:${process.env.PATH}`,
          CHECK_SENTINEL: sentinel,
        },
        cwd: worktree,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(0)
    expect(existsSync(sentinel)).toBe(true)
    expect(readFileSync(sentinel, 'utf8').trim()).toBe(realpathSync(worktree))
  })

  test('a project typos config cannot override American English', () => {
    const root = repository('checks-american-english')
    writeFileSync(join(root, 'typos.toml'), '[default]\nlocale = "en-gb"\n')
    writeFileSync(join(root, 'README.md'), `${britishSample}\n`)
    const bin = mkdtempSync(join(dir, 'american-english-bin-'))
    const typos = join(bin, 'typos')
    writeFileSync(
      typos,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "typos-cli 1.50.0"; exit 0; fi\ncase " $* " in *" --locale en-us "*) ;; *) exit 9 ;; esac\nprintf '%s\\n' '{"type":"typo","path":"./README.md","line_num":1,"byte_offset":0,"typo":"${britishSample}","corrections":["color"]}'\nexit 2\n`,
    )
    chmodSync(typos, 0o755)
    const database = registerProject('checks-american-english', root, {
      trunk: 'main',
      checks: { spelling: true },
    })

    const result = spawnFixtureSync(
      ['bun', '--no-env-file', cli, 'check', '--enabled', '--project', 'checks-american-english'],
      {
        env: { ...process.env, ORCH_DB: database, PATH: `${bin}:${process.env.PATH}` },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain(`README.md:1:1 ${britishSample} -> color`)
    expect(result.stdout.toString()).toContain('failed check: spelling')
  })

  test('an opted-out project passes a marker-bearing pull request', () => {
    const root = repository('checks-pr-out')
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
        env: { ...process.env, ORCH_DB: database, PATH: `${gh}:${process.env.PATH}` },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('no checks enabled for checks-pr-out')
  })

  test('an opted-in project fails a marker-bearing pull request', () => {
    const root = repository('checks-pr-in')
    const gh = installGh()
    const database = registerProject('checks-pr-in', root, {
      trunk: 'main',
      checks: { attribution: true },
    })

    const result = spawnFixtureSync(
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
        env: { ...process.env, ORCH_DB: database, PATH: `${gh}:${process.env.PATH}` },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain('pr:1: Generated with Codex')
    expect(result.stdout.toString()).toContain('failed check: attribution')
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
          ORCH_DB: database,
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
