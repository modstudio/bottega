import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { claimRun } from './run-claim.ts'

test("a later findings turn inherits its root's implicit review branch", async () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const reserved = addRun({ agent: '(pending)', job: 'review-lens', status: 'running' })
  const reservedRecordId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(reserved)!.record_id
  expect(reservedRecordId[14]).toBe('7')
  const carriedQuestionId = (
    db()
      .query<{ id: number }, [string, string]>(
        `INSERT INTO question (record_id,run_record_id,asked_at,question)
         VALUES (?,?,'2026-10-14','Which?') RETURNING id`,
      )
      .get(newRecordId(), root) as { id: number }
  ).id
  db().query('UPDATE run SET branch=? WHERE record_id=?').run('DEV-1147-reviewed', root)
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

  try {
    const claimed = await claimRun({
      opts: {
        job: 'review-lens',
        reserveId: reserved,
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
      carriedQuestionIds: [carriedQuestionId],
    })

    expect(claimed.claim.id).toBe(reserved)
    expect(
      db().query('SELECT branch,record_id FROM run WHERE record_id=?').get(claimed.claim.id),
    ).toEqual({
      branch: 'DEV-1147-reviewed',
      record_id: reservedRecordId,
    })
    expect(
      db()
        .query<{ record_id: string }, [string]>(
          'SELECT record_id FROM run_carried_ruling WHERE run_record_id=?',
        )
        .get(claimed.claim.id)?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})
