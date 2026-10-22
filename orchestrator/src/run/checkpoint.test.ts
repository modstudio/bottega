import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import { git } from '../git/git-environment.ts'
import { checkpointRun } from './checkpoint.ts'

const temporary = mkdtempSync(join(tmpdir(), 'orch-checkpoint-'))
const branch = 'DEV-835-checkpoint-test'
const hostContainment = { gitDir: null, hooksDir: null, disableHooks: false } as const
const identity = {
  GIT_AUTHOR_NAME: 'Orch Test',
  GIT_AUTHOR_EMAIL: 'orch@example.invalid',
  GIT_COMMITTER_NAME: 'Orch Test',
  GIT_COMMITTER_EMAIL: 'orch@example.invalid',
}

afterAll(() => rmSync(temporary, { recursive: true, force: true }))

function fixture(name: string): { database: Database; repository: string; runId: string } {
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
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (835,?,'2026-10-15','codex','implement','sha',1,'checkpoint','running')`,
    )
    .run(runId)
  return { database, repository, runId }
}

function checkpoint(database: Database, repository: string, runId: string) {
  return checkpointRun({
    database,
    runId,
    worktree: repository,
    branch,
    taskKey: 'DEV-835',
    scratchDir: temporary,
    guardEnvironment: identity,
    containment: hostContainment,
  })
}

test('checkpoint commits a fresh untracked file', () => {
  const { database, repository, runId } = fixture('untracked')
  try {
    writeFileSync(join(repository, 'fresh.ts'), 'export const fresh = true\n')

    expect(checkpoint(database, repository, runId).created).toBe(true)
    expect(git(['show', '--format=', '--name-only', 'HEAD'], repository)).toBe('fresh.ts')
    expect(
      database.query<{ record_id: string }, []>('SELECT record_id FROM run_checkpoint').get()
        ?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  } finally {
    database.close()
  }
})

test('checkpoint does not commit a gitignored file', () => {
  const { database, repository, runId } = fixture('ignored')
  try {
    writeFileSync(join(repository, '.gitignore'), '*.log\n')
    writeFileSync(join(repository, 'ignored.log'), 'not checkpointed\n')

    expect(checkpoint(database, repository, runId).created).toBe(true)
    expect(git(['show', '--format=', '--name-only', 'HEAD'], repository)).toBe('.gitignore')
  } finally {
    database.close()
  }
})

test('a writing ACP checkpoint uses its recorded gitdir and never runs authored hooks', () => {
  const { database, repository, runId } = fixture('acp-hooks')
  try {
    const hooks = join(repository, '.githooks')
    mkdirSync(hooks)
    const hook = join(hooks, 'reference-transaction')
    writeFileSync(hook, '#!/bin/sh\nexit 91\n')
    chmodSync(hook, 0o755)
    git(['config', 'core.hooksPath', '.githooks'], repository)
    writeFileSync(join(repository, 'fresh.ts'), 'export const fresh = true\n')
    mkdirSync(join(temporary, 'checkpoint-hooks'), { recursive: true })

    const result = checkpointRun({
      database,
      runId,
      worktree: repository,
      branch,
      taskKey: 'DEV-835',
      scratchDir: temporary,
      guardEnvironment: identity,
      containment: {
        gitDir: join(repository, '.git'),
        hooksDir: join(temporary, 'checkpoint-hooks'),
        disableHooks: true,
      },
    })

    expect(result.created).toBe(true)
    expect(git(['show', '--format=', '--name-only', 'HEAD'], repository)).toContain('fresh.ts')
  } finally {
    database.close()
  }
})
