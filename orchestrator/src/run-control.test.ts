import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun, dir } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import { ARGV_PROMPT_BYTES } from './agents.ts'
import { packResumePrompt } from './contract.ts'
import { db } from './db.ts'
import { recordReview } from './review-triage.ts'
import { continueRun } from './run-control.ts'
import { packedResumePrompt } from './run.ts'
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

describe('run continuation', () => {
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
})
