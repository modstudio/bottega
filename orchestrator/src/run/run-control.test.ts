import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { packResumePrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { recordReview } from '../review/review-triage.ts'
import { packedResumePrompt } from './run.ts'
import {
  type ChainTurn,
  continuationTurn,
  continueRun,
  resumeLaunchFromStored,
} from './run-control.ts'

const trackResidue = trackedTestResidue()

const limit = () => ARGV_PROMPT_BYTES

function insert(status: string, job = 'file-question'): number {
  return (
    db()
      .query(
        `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
      )
      .get(new Date().toISOString(), job, status) as { id: number }
  ).id
}

const priorEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  priorEnv.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID
  priorEnv.ORCH_DEPTH = process.env.ORCH_DEPTH
  priorEnv.ORCH_EXEC_PATH = process.env.ORCH_EXEC_PATH
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  process.env.ORCH_DEPTH = '0'
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
  ] as const)('maps stored mcp %s with error %s to %s', (mcp, mcp_error, expected) => {
    expect(resumeLaunchFromStored({ ...stored, mcp, mcp_error })).toEqual({
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
})

describe('run continuation', () => {
  test('a continuation resumes from the newest turn that started, numbered past every turn', () => {
    const turn = (id: number, agent: string, n: number): ChainTurn => ({
      id,
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
      turn(10, 'codex', 1),
      turn(11, 'codex', 2),
      turn(12, '(pending)', 3),
      turn(13, '(pending)', 4),
    ]

    const { latest, nextTurn } = continuationTurn(10, chain)

    expect(latest).toMatchObject({ id: 11, agent: 'codex', worktree: '/tree' })
    expect(nextTurn).toBe(5)
  })

  test('a chain with no started turn cannot be continued', async () => {
    const root = addRun({
      agent: '(pending)',
      job: 'implement',
      status: 'failed',
      session: 'orch-test-session',
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
        `SELECT r.id,r.completed_at,rl.id lens_id,rl.run_id
       FROM review r JOIN review_lens rl ON rl.review_id=r.id WHERE r.id=?`,
      )
      .get(reviewId)
    await expect(continueRun(root, 'review another turn', limit)).rejects.toThrow(
      "invariant: a recorded review is the run's product and is not re-terminalised",
    )
    expect(
      db()
        .query(
          `SELECT r.id,r.completed_at,rl.id lens_id,rl.run_id
       FROM review r JOIN review_lens rl ON rl.review_id=r.id WHERE r.id=?`,
        )
        .get(reviewId),
    ).toEqual(before)
  })

  test('continue --file refuses when a just-below-limit body plus the reminder exceeds argv', async () => {
    const root = insert('ok')
    const longSpec = 's'.repeat(600)
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', 'x'))
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = trackResidue(join(dir, `continue-long-${root}.prompt.txt`))
    writeFileSync(spec, longSpec)
    db()
      .query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE id=?')
      .run('parent-session', 'codex', spec, 'orch-test-session', root)
    const assembled = Buffer.byteLength(packedResumePrompt('file-question', body, root))
    await expect(continueRun(root, body, limit)).rejects.toThrow(
      `assembled resume prompt is ${assembled} bytes`,
    )
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root)).toEqual({
      n: 0,
    })
  })

  test('vendor-session continuation does not recover prior instructions', async () => {
    const root = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'failed',
      session: 'orch-test-session',
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
      .query('UPDATE run SET vendor_session=? WHERE id IN (?,?)')
      .run('vendor-session', root, prior)

    const resumed = await continueRun(root, 'vendor-session message', limit)
    const artifact = db().query('SELECT prompt_path FROM run WHERE id=?').get(resumed.childId) as {
      prompt_path: string
    }

    trackResidue(artifact.prompt_path)
    expect(readFileSync(artifact.prompt_path, 'utf8')).toBe('vendor-session message')
  })
})
