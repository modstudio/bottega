import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { packResumePrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { recordReview } from '../review/review-triage.ts'
import { continuationMessageBinding } from './continuation-message.ts'
import {
  type ChainTurn,
  continuationTurn,
  continueRun,
  resumeLaunchFromStored,
} from './run-control.ts'
import { packedResumePrompt } from './run-resume-prompt.ts'

const trackResidue = trackedTestResidue()

const limit = () => ARGV_PROMPT_BYTES

function insert(status: string, job = 'file-question'): string {
  return (
    db()
      .query(
        `INSERT INTO run (record_id,number,started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status,
                         repo, cwd, worktree)
     VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?, 'codex', ?, 'x', 1, 'x', ?, 'continuation-fixture', ?, ?) RETURNING record_id AS id`,
      )
      .get(new Date().toISOString(), job, status, dir, dir) as { id: string }
  ).id
}

const priorEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: dir })
  priorEnv.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID
  priorEnv.ORCH_DEPTH = process.env.ORCH_DEPTH
  priorEnv.ORCH_EXEC_PATH = process.env.ORCH_EXEC_PATH
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.ORCH_DEPTH
  process.env.ORCH_EXEC_PATH = '/usr/bin/true'
})
afterEach(() => {
  if (priorEnv.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorEnv.CLAUDE_CODE_SESSION_ID
  if (priorEnv.ORCH_DEPTH === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = priorEnv.ORCH_DEPTH
  if (priorEnv.ORCH_EXEC_PATH === undefined) delete process.env.ORCH_EXEC_PATH
  else process.env.ORCH_EXEC_PATH = priorEnv.ORCH_EXEC_PATH
})

describe('inherited resume launch', () => {
  const stored = {
    launch_seed: null as string | null,
    launch_key: null as string | null,
    launch_base: null as string | null,
    base_commit: null as string | null,
    no_failover: 0,
    mcp: null as number | null,
    mcp_error: null as string | null,
    lens: null as string | null,
  }

  test.each([
    [1, 'verified', 'require'],
    [1, 'mirror: attach failed', 'prefer'],
    [2, null, 'prefer'],
    [0, null, undefined],
    [null, null, undefined],
  ] as const)('maps stored mcp %s with error %s to %s', (mcp, mcpError, expected) => {
    expect(resumeLaunchFromStored({ ...stored, mcp, mcp_error: mcpError })).toEqual({
      seed: undefined,
      key: undefined,
      base: undefined,
      noFailover: false,
      mcp: expected,
      lens: undefined,
    })
  })

  test('maps null key, seed, base and lens to undefined', () => {
    expect(resumeLaunchFromStored(stored)).toEqual({
      seed: undefined,
      key: undefined,
      base: undefined,
      noFailover: false,
      mcp: undefined,
      lens: undefined,
    })
  })

  test('resumes from the recorded base commit after the launch branch is gone', () => {
    expect(
      resumeLaunchFromStored({
        ...stored,
        launch_base: 'DEV-1042-orch-8083',
        base_commit: '956304fe',
      }).base,
    ).toBe('956304fe')
  })

  test('a reader with a clone commit but no launch base resumes without a base', () => {
    expect(resumeLaunchFromStored({ ...stored, base_commit: '956304fe' }).base).toBeUndefined()
  })

  test('falls back to the launch branch for an old row without a base commit', () => {
    expect(resumeLaunchFromStored({ ...stored, launch_base: 'DEV-1042-orch-8083' }).base).toBe(
      'DEV-1042-orch-8083',
    )
  })
})

describe('run continuation', () => {
  test('a continuation resumes from the newest turn that started, numbered past every turn', () => {
    const turn = (id: string, agent: string, n: number): ChainTurn => ({
      record_id: id,
      agent,
      vendor_session: agent === '(pending)' ? null : 'session',
      turn: n,
      cwd: agent === '(pending)' ? null : '/tree',
      worktree: agent === '(pending)' ? null : '/tree',
      branch: agent === '(pending)' ? null : 'branch',
      base_commit: null,
      worktree_source: agent === '(pending)' ? null : 'git',
    })
    const chain = [
      turn('run-10', 'codex', 1),
      turn('run-11', 'codex', 2),
      turn('run-12', '(pending)', 3),
      turn('run-13', '(pending)', 4),
    ]

    const { latest, nextTurn } = continuationTurn('run-10', chain)

    expect(latest).toMatchObject({ record_id: 'run-11', agent: 'codex', worktree: '/tree' })
    expect(nextTurn).toBe(5)
  })

  test('a chain with no started turn cannot be continued', async () => {
    const root = addRun({
      agent: '(pending)',
      job: 'implement',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })

    await expect(continueRun(root, undefined, limit)).rejects.toThrow(
      `run ${root} cannot be continued: no turn in its chain ever started`,
    )
  })

  test('a findings root with a recorded review cannot be re-terminalised', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'review-lens',
      status: 'ok',
      lens: 'correctness',
      session: 'orch-test-session',
    })
    const reviewId = recordReview(root, reviewReply(1, 'high'), db())
    const before = db()
      .query(
        `SELECT r.record_id,r.completed_at,rl.record_id lens_id,rl.run_record_id
       FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id WHERE r.record_id=?`,
      )
      .get(reviewId)
    await expect(continueRun(root, 'review another turn', limit)).rejects.toThrow(
      "invariant: a recorded review is the run's product and is not re-terminalised",
    )
    expect(
      db()
        .query(
          `SELECT r.record_id,r.completed_at,rl.record_id lens_id,rl.run_record_id
       FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id WHERE r.record_id=?`,
        )
        .get(reviewId),
    ).toEqual(before)
  })

  test('an open question refuses before a continuation message callback is called', async () => {
    const root = insert('asking')
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(root, new Date().toISOString(), 'Which correction should be applied?')
    let calls = 0

    await expect(
      continueRun(root, 'architect message', limit, () => {
        calls++
        return 'rendered findings'
      }),
    ).rejects.toThrow(
      `run ${root} is waiting on 1 question(s): ${PLATFORM_SLUG} question answer ${root} ...`,
    )
    expect(calls).toBe(0)
  })

  test('continue --file refuses when a just-below-limit body plus the reminder exceeds argv', async () => {
    const root = insert('ok')
    const longSpec = 's'.repeat(600)
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', 'x'))
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = trackResidue(join(dir, `continue-long-${root}.prompt.txt`))
    writeFileSync(spec, longSpec)
    db()
      .query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE record_id=?')
      .run('parent-session', 'codex', spec, 'orch-test-session', root)
    const assembled = Buffer.byteLength(packedResumePrompt('file-question', body, root))
    await expect(continueRun(root, body, limit)).rejects.toThrow(
      `assembled resume prompt is ${assembled} bytes`,
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(root)).toEqual(
      {
        n: 0,
      },
    )
  })

  test('vendor-session continuation does not recover prior instructions', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'failed',
      session: 'orch-test-session',
      repo: 'continuation-fixture',
    })
    const prior = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'failed',
      parent: root,
      turn: 2,
      session: 'orch-test-session',
    })
    db()
      .query('UPDATE run SET vendor_session=?,cwd=?,worktree=? WHERE record_id IN (?,?)')
      .run('vendor-session', dir, dir, root, prior)

    const resumed = await continueRun(root, 'vendor-session message', limit)
    const artifact = db()
      .query('SELECT prompt_path,continuation_message_sha FROM run WHERE record_id=?')
      .get(resumed.childId) as {
      prompt_path: string
      continuation_message_sha: string
    }

    trackResidue(artifact.prompt_path)
    expect(readFileSync(artifact.prompt_path, 'utf8')).toBe('vendor-session message')
    expect(artifact.continuation_message_sha).toBe(
      continuationMessageBinding('vendor-session message').sha256,
    )
  })

  test('a released reader with an unavailable base refuses before creating a turn', async () => {
    const root = insert('ok')
    db()
      .query('UPDATE run SET vendor_session=?,worktree=NULL,base_commit=? WHERE record_id=?')
      .run('vendor-session', 'missing-reader-base', root)

    await expect(continueRun(root, 'deliver queued messages', limit)).rejects.toThrow(
      'read-only base commit missing-reader-base is unavailable',
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_record_id=?').get(root)).toEqual(
      {
        n: 0,
      },
    )
  })

  test('a repository-free continuation needs neither a project nor a reader base', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'summarize',
      status: 'ok',
      session: 'orch-test-session',
    })
    db()
      .query(
        'UPDATE run SET vendor_session=?,cwd=?,worktree=NULL,base_commit=NULL WHERE record_id=?',
      )
      .run('vendor-session', dir, root)

    const resumed = await continueRun(root, 'summarize one more thing', limit)

    expect(resumed).toEqual({ childId: expect.stringMatching(/^[0-9a-f-]{36}$/), job: 'summarize' })
  })
})
