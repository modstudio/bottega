import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  addProject,
  git,
  gitRepository,
  removeGitRepository,
} from '../../test/fixtures/offline-branch-landing.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { composeBranchDisposalRefusal, disposeBranch } from './branch-disposal.ts'

test('open-task refusal identifies the mirrored status and refresh remedy', () => {
  const refusal = composeBranchDisposalRefusal({
    reason: 'open-task',
    project: 'example',
    branch: 'DEV-2061-work',
    taskKey: 'DEV-2061',
    taskStatus: {
      raw: 'In Progress',
      category: 'active',
      lastSeen: '2026-11-02T12:00:00.000Z',
      verified: true,
      detail: 'In Progress',
    },
  })

  expect(refusal).toContain('In Progress')
  expect(refusal).toContain('last changed 2026-11-02T12:00:00.000Z')
  expect(refusal).toContain(`record pull, then retry ${PLATFORM_SLUG} tree branch dispose`)
  expect(refusal).toContain('--operator')
})

test('open-task refusal renders an unknown mirror observation time', () => {
  const refusal = composeBranchDisposalRefusal({
    reason: 'open-task',
    project: 'example',
    branch: 'DEV-2061-work',
    taskKey: 'DEV-2061',
    taskStatus: {
      raw: null,
      category: 'active',
      lastSeen: null,
      verified: true,
      detail: 'active',
    },
  })

  expect(refusal).toContain('the task mirror reads active (last changed unknown)')
})

test('open-task refusal identifies a branch without a task key', () => {
  const refusal = composeBranchDisposalRefusal({
    reason: 'open-task',
    project: 'example',
    branch: 'unkeyed-work',
    taskKey: null,
    taskStatus: {
      raw: null,
      category: null,
      lastSeen: null,
      verified: false,
      detail: 'unkeyed',
    },
  })

  expect(refusal).toBe(
    'refusing branch disposal: open-task; the branch carries no task key; cleared by: repeat with --operator after the operator rules that its unique work may be disposed',
  )
})

test('open-task refusal identifies a failed task status read and its diagnostic command', () => {
  const refusal = composeBranchDisposalRefusal({
    reason: 'open-task',
    project: 'example',
    branch: 'DEV-2061-work',
    taskKey: 'DEV-2061',
    taskStatus: {
      raw: null,
      category: null,
      lastSeen: null,
      verified: false,
      detail: 'unverified (exit 1)',
    },
  })

  expect(refusal).toBe(
    `refusing branch disposal: open-task; the task status could not be read (unverified (exit 1)); cleared by: run ${PLATFORM_SLUG} task show DEV-2061 --project example to see why the read failed; or repeat with --operator after the operator rules that its unique work may be disposed`,
  )
})

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
