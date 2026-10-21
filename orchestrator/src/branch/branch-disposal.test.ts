import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addProject,
  git,
  gitRepository,
  removeGitRepository,
} from '../../test/fixtures/offline-branch-landing.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { disposeBranch } from './branch-disposal.ts'

test('failed settlement restores the branch and removes every disposal artifact', () => {
  const repository = gitRepository('disposal-rollback')
  const project = `disposal-rollback-${crypto.randomUUID()}`
  const key = 'DEV-1463'
  const branch = `${key}-rollback`
  const bin = mkdtempSync(join(tmpdir(), 'orch-branch-disposal-bin-'))
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorPath = process.env.PATH
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'branch-disposal-test'
    git(repository, 'config', 'user.name', 'Fixture')
    git(repository, 'config', 'user.email', 'fixture@example.com')
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n')
    chmodSync(join(bin, 'gh'), 0o755)
    process.env.PATH = `${bin}:${priorPath ?? ''}`
    git(repository, 'remote', 'add', 'origin', 'https://github.com/example/example.git')
    git(repository, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main')
    git(repository, 'checkout', '-b', branch)
    writeFileSync(join(repository, 'state.txt'), 'unique work\n')
    git(repository, 'commit', '-am', `${key} unique work`)
    const tip = git(repository, 'rev-parse', 'HEAD')
    git(repository, 'checkout', 'main')

    const projectId = addProject(project, repository)
    const runId = addRun({ agent: 'codex', job: 'disposal rollback', repo: project })
    db()
      .query(
        'UPDATE run SET project_record_id=?,launch_key=?,branch=?,minted_branch=? WHERE record_id=?',
      )
      .run(projectId, key, branch, branch, runId)

    expect(() =>
      disposeBranch(
        {
          target: `${project}:${branch}`,
          reason: 'throwaway',
          note: 'test rollback',
          operator: true,
        },
        {
          settle: () => {
            throw new Error('settlement failed')
          },
          record: () => {
            throw new Error('recording must follow settlement')
          },
        },
      ),
    ).toThrow('settlement failed')

    expect(git(repository, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
    expect(git(repository, 'for-each-ref', '--format=%(refname)', 'refs/orch/archive')).toBe('')
    expect(db().query('SELECT count(*) n FROM branch_disposal').get()).toEqual({ n: 0 })
    expect(db().query("SELECT count(*) n FROM outbox WHERE kind='branch_disposal'").get()).toEqual({
      n: 0,
    })
    expect(existsSync(repository)).toBe(true)
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    rmSync(bin, { recursive: true, force: true })
    removeGitRepository(repository)
  }
})
