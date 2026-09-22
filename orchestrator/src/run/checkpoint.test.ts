import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../database/migrations.ts'
import { git } from '../git/git-environment.ts'
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

function fixture(name: string): { database: Database; repository: string } {
  const repository = join(temporary, name)
  mkdirSync(repository)
  git(['init', '-b', branch], repository)
  writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = true\n')
  git(['add', 'tracked.ts'], repository)
  git(
    [
      '-c',
      'user.name=Orch Test',
      '-c',
      'user.email=orch@example.invalid',
      'commit',
      '-m',
      'initial',
    ],
    repository,
  )
  const database = new Database(':memory:')
  applyMigrations(database)
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
    expect(git(['show', '--format=', '--name-only', 'HEAD'], repository)).toBe('fresh.ts')
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
    expect(git(['show', '--format=', '--name-only', 'HEAD'], repository)).toBe('.gitignore')
  } finally {
    database.close()
  }
})
