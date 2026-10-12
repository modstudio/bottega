import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { runFilePaths } from './run-artifacts.ts'
import { claimRun } from './run-claim.ts'

function fixtureRepository(parent: string): { path: string; head: string } {
  const path = join(parent, 'repository')
  Bun.spawnSync(['git', 'init', '-b', 'main', path])
  writeFileSync(join(path, 'fixture.txt'), 'fixture\n')
  Bun.spawnSync(['git', 'add', 'fixture.txt'], { cwd: path })
  Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: path },
  )
  return {
    path,
    head: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: path }).stdout.toString().trim(),
  }
}

test("a later findings turn inherits its root's implicit review branch", async () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  db().query('UPDATE run SET branch=? WHERE id=?').run('DEV-1147-reviewed', root)
  const runsDir = mkdtempSync(join(tmpdir(), 'later-findings-claim-'))
  const repository = fixtureRepository(runsDir)
  const paths = runFilePaths(runsDir, Date.now(), 'later', 'codex', 'review-lens')

  try {
    const claimed = await claimRun({
      opts: {
        job: 'review-lens',
        resume: {
          kind: 'continue',
          parent: root,
          agent: 'codex',
          turn: 2,
          sessionId: null,
          worktree: {
            path: repository.path,
            branch: '',
            base: repository.head,
            repoRoot: repository.path,
          },
        },
      },
      runsDir,
      paths,
      stamp: 'later-findings-claim',
      name: 'codex',
      generatedSchema: null,
      originalPrompt: 'review the change',
      prompt: 'review the change',
      callerCwd: repository.path,
      seed: undefined,
      writesJob: false,
      repoJob: true,
      runProjectName: null,
      runProjectId: null,
      reason: 'test',
      vendorSession: null,
      pack: null,
      mcpRequest: undefined,
      transportName: 'cli',
      a: AGENTS.codex!,
      mcpConnection: null,
      mcpMode: null,
      declaredDeliverables: [],
      timeoutMinutes: undefined,
      timeoutMs: 60_000,
      forbidsRepo: false,
      reviewTarget: null,
      implicitReview: { branch: null, findings: true },
      coverageBase: null,
      readOnlyBase: repository.head,
      deferredCwdMcpPreflight: false,
      usingMcp: false,
      startedByUserId: null,
      replySchemaName: 'WORKER_SCHEMA',
      carriedQuestionIds: [],
    })

    expect(db().query('SELECT branch FROM run WHERE id=?').get(claimed.claim.id)).toEqual({
      branch: 'DEV-1147-reviewed',
    })
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('a read-only retry root records its fresh tree without a tree plan', async () => {
  const root = addRun({ agent: 'codex', job: 'file-question', status: 'failed' })
  const runsDir = mkdtempSync(join(tmpdir(), 'reader-retry-claim-'))
  const repository = fixtureRepository(runsDir)
  const paths = runFilePaths(runsDir, Date.now(), 'reader-retry', 'codex', 'file-question')

  try {
    const claimed = await claimRun({
      opts: {
        job: 'file-question',
        resume: {
          kind: 'retry-root',
          parent: root,
          agent: 'codex',
          turn: 1,
          sessionId: null,
          worktree: null,
          readOnlyBase: repository.head,
        },
      },
      runsDir,
      paths,
      stamp: 'reader-retry-claim',
      name: 'codex',
      generatedSchema: null,
      originalPrompt: 'read the repository',
      prompt: 'read the repository',
      callerCwd: repository.path,
      seed: undefined,
      writesJob: false,
      repoJob: true,
      runProjectName: null,
      runProjectId: null,
      reason: 'test',
      vendorSession: null,
      pack: null,
      mcpRequest: undefined,
      transportName: 'cli',
      a: AGENTS.codex!,
      mcpConnection: null,
      mcpMode: null,
      declaredDeliverables: [],
      timeoutMinutes: undefined,
      timeoutMs: 60_000,
      forbidsRepo: false,
      reviewTarget: null,
      implicitReview: { branch: null, findings: false },
      coverageBase: null,
      readOnlyBase: repository.head,
      deferredCwdMcpPreflight: false,
      usingMcp: false,
      startedByUserId: null,
      replySchemaName: 'WORKER_SCHEMA',
      carriedQuestionIds: [],
    })

    expect(claimed.worktree).toMatchObject({
      branch: '',
      base: repository.head,
      source: 'clone',
    })
    expect(
      db().query('SELECT status,branch,base_commit FROM run WHERE id=?').get(claimed.claim.id),
    ).toEqual({ status: 'running', branch: null, base_commit: repository.head })
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})
