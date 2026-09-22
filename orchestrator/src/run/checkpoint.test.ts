import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointRun } from './checkpoint.ts'

const temporary = mkdtempSync(join(tmpdir(), 'orch-checkpoint-'))
const branch = 'DEV-835-checkpoint-test'
const identity = {
  GIT_AUTHOR_NAME: 'Orch Test',
  GIT_AUTHOR_EMAIL: 'orch@example.invalid',
  GIT_COMMITTER_NAME: 'Orch Test',
  GIT_COMMITTER_EMAIL: 'orch@example.invalid',
}

afterAll(() => rmSync(temporary, { recursive: true, force: true }))

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', repository, ...args], {
    env: { ...process.env, ...identity },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args[0]} exited ${result.exitCode}`)
  }
  return result.stdout.toString().trim()
}

function fixture(name: string): { database: Database; repository: string } {
  const repository = join(temporary, name)
  mkdirSync(repository)
  git(repository, 'init', '-b', branch)
  writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = true\n')
  git(repository, 'add', 'tracked.ts')
  git(repository, 'commit', '-m', 'initial')
  const database = new Database(':memory:')
  database.run(`CREATE TABLE run_checkpoint (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    checkpoint_no INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    task_pointer TEXT,
    final INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`)
  return { database, repository }
}

function checkpoint(database: Database, repository: string) {
  return checkpointRun({
    database,
    runId: 835,
    worktree: repository,
    branch,
    taskKey: 'DEV-835',
    scratchDir: temporary,
    guardEnvironment: identity,
  })
}

test('checkpoint commits a fresh untracked file', () => {
  const { database, repository } = fixture('untracked')
  try {
    writeFileSync(join(repository, 'fresh.ts'), 'export const fresh = true\n')

    expect(checkpoint(database, repository).created).toBe(true)
    expect(git(repository, 'show', '--format=', '--name-only', 'HEAD')).toBe('fresh.ts')
  } finally {
    database.close()
  }
})

test('checkpoint does not commit a gitignored file', () => {
  const { database, repository } = fixture('ignored')
  try {
    writeFileSync(join(repository, '.gitignore'), '*.log\n')
    writeFileSync(join(repository, 'ignored.log'), 'not checkpointed\n')

    expect(checkpoint(database, repository).created).toBe(true)
    expect(git(repository, 'show', '--format=', '--name-only', 'HEAD')).toBe('.gitignore')
  } finally {
    database.close()
  }
})
