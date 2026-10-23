import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { spawnFixtureGitSync, spawnFixtureSync } from '../../test/fixtures/spawn.ts'
import { dir } from '../../test/preload.ts'
import { writeMigratedTestDatabase } from '../database/test-database.fixture.ts'
import type { ProjectSettings } from '../project/projects.ts'

const cli = resolve(import.meta.dir, '../cli/orch.ts')
const britishSample = readFileSync(
  join(import.meta.dir, 'fixtures/spelling-samples/british-samples.txt'),
  'utf8',
).trim()
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureDirectory(prefix: string): string {
  const root = mkdtempSync(join(dir, prefix))
  fixtureRoots.push(root)
  return root
}

function run(database: string, ...argv: string[]) {
  return spawnFixtureSync(['bun', '--no-env-file', cli, 'check', '--enabled', ...argv], {
    env: { ...process.env, BOTTEGA_ORCHESTRATOR_DB: database },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function registerProject(name: string, path: string, settings: ProjectSettings): string {
  const databasePath = join(fixtureDirectory('enabled-check-db-'), 'orch.db')
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

describe(`${PLATFORM_SLUG} gate check --enabled`, () => {
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
          BOTTEGA_ORCHESTRATOR_DB: database,
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
    const bin = fixtureDirectory('american-english-bin-')
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
        env: {
          ...process.env,
          BOTTEGA_ORCHESTRATOR_DB: database,
          PATH: `${bin}:${process.env.PATH}`,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain(`README.md:1:1 ${britishSample} -> color`)
    expect(result.stdout.toString()).toContain('failed check: spelling')
  })
})
