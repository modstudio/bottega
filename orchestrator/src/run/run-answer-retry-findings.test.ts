import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFlags as flags,
  answerRunHelpers as helpers,
} from '../../test/fixtures/run-answer.ts'
import { installRunAnswerEnvironment } from '../../test/fixtures/run-answer-environment.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { retryRun } from './run-answer.ts'

let restoreEnvironment: () => void
beforeEach(() => {
  restoreEnvironment = installRunAnswerEnvironment()
})
afterEach(() => restoreEnvironment())

test('a writing retry preserves the findings continuation flag', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'findings-retry-'))
  try {
    const git = (...args: string[]) => {
      const result = spawnFixtureGitSync(args, { cwd: repository })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'fixture@example.com')
    git('config', 'user.name', 'Fixture')
    writeFileSync(join(repository, 'file.txt'), 'base\n')
    git('add', 'file.txt')
    git('commit', '-m', 'base')
    git('checkout', '-b', 'DEV-1-findings')
    upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: repository })
    const id = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      repo: 'continuation-fixture',
    })
    db()
      .query(
        `UPDATE run SET session_id='orch-test-session',vendor_session='findings-session',
                        continued_with_findings=1,cwd=?,worktree=?,worktree_source='git',
                        branch='DEV-1-findings',base_commit=?
         WHERE record_id=?`,
      )
      .run(repository, repository, gitContext(repository, 'rev-parse', '--verify', 'HEAD'), id)

    const childId = await retryRun(id, { flags }, helpers)

    expect(
      db().query('SELECT continued_with_findings FROM run WHERE record_id=?').get(childId),
    ).toEqual({ continued_with_findings: 1 })
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
})
