import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { runFilePaths } from './run-artifacts.ts'
import { claimRun } from './run-claim.ts'

test("a later findings turn inherits its root's implicit review branch", async () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  db().query('UPDATE run SET branch=? WHERE id=?').run('DEV-1147-reviewed', root)
  const runsDir = mkdtempSync(join(tmpdir(), 'later-findings-claim-'))
  const repository = join(runsDir, 'repository')
  Bun.spawnSync(['git', 'init', '-b', 'main', repository])
  writeFileSync(join(repository, 'fixture.txt'), 'fixture\n')
  Bun.spawnSync(['git', 'add', 'fixture.txt'], { cwd: repository })
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
    { cwd: repository },
  )
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repository })
    .stdout.toString()
    .trim()
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
          worktree: { path: repository, branch: '', base: head, repoRoot: repository },
        },
      },
      runsDir,
      paths,
      stamp: 'later-findings-claim',
      name: 'codex',
      generatedSchema: null,
      originalPrompt: 'review the change',
      prompt: 'review the change',
      callerCwd: repository,
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
      readOnlyBase: head,
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
