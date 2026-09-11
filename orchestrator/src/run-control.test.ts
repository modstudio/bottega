import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARGV_PROMPT_BYTES, addRun, db, dir, packResumePrompt, packedResumePrompt,
  recordReview, reviewReply,
} from '../test/fixture.ts'
import { continueRun } from './run-control.ts'
import { trackedTestResidue } from '../test/residue.ts'
const trackResidue = trackedTestResidue()

const limit = () => ARGV_PROMPT_BYTES

function insert(status: string, job = 'file-question'): number {
  return (db().query(
    `INSERT INTO run (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
     VALUES (?, 'codex', ?, 'x', 1, 'x', ?) RETURNING id`,
  ).get(new Date().toISOString(), job, status) as { id: number }).id
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
  if (priorEnv.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = priorEnv.CLAUDE_CODE_SESSION_ID
  if (priorEnv.ORCH_DEPTH === undefined) delete process.env.ORCH_DEPTH; else process.env.ORCH_DEPTH = priorEnv.ORCH_DEPTH
  if (priorEnv.ORCH_EXEC_PATH === undefined) delete process.env.ORCH_EXEC_PATH; else process.env.ORCH_EXEC_PATH = priorEnv.ORCH_EXEC_PATH
})

describe('run continuation', () => {
  test('stopped roots resume while stale roots cannot claim another continuation turn', async () => {
    for (const status of ['stopped', 'stale']) {
      const id = addRun({ agent: 'codex', job: 'implement', status, session: 'orch-test-session' })
      db().query('UPDATE run SET vendor_session=? WHERE id=?').run(`${status}-vendor-session`, id)
      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      if (status === 'stopped') {
        const continued = await continueRun(id, 'resume after lifecycle mutation', limit)
        expect(continued.childId).toBeGreaterThan(id)
        expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
        expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(id))
          .toEqual([{ action: 'continue' }])
      } else {
        await expect(continueRun(id, 'resume after lifecycle mutation', limit))
          .rejects.toThrow(`run ${id} is stale and cannot be continued`)
        expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
      }
    }
  })

  test('a findings root with a recorded review cannot be re-terminalised', async () => {
    const root = addRun({
      agent: 'codex', job: 'review-lens', status: 'ok', lens: 'correctness', session: 'orch-test-session',
    })
    const reviewId = recordReview(root, reviewReply(1, 'high'), db())
    const before = db().query(
      `SELECT r.id,r.completed_at,rl.id lens_id,rl.run_id
       FROM review r JOIN review_lens rl ON rl.review_id=r.id WHERE r.id=?`,
    ).get(reviewId)
    await expect(continueRun(root, 'review another turn', limit))
      .rejects.toThrow("invariant: a recorded review is the run's product and is not re-terminalised")
    expect(db().query(
      `SELECT r.id,r.completed_at,rl.id lens_id,rl.run_id
       FROM review r JOIN review_lens rl ON rl.review_id=r.id WHERE r.id=?`,
    ).get(reviewId)).toEqual(before)
  })

  test("continue falls back to the chain's newest session when the latest turn has none", async () => {
    const root = insert('ok')
    const prompt = trackResidue(join(dir, `continue-root-${root}.prompt.txt`))
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE id=?')
      .run('parent-session', 'codex', prompt, 'orch-test-session', root)
    const stale = insert('stale')
    db().query('UPDATE run SET parent_run_id=?,turn=2,vendor_session=NULL,agent=? WHERE id=?')
      .run(root, 'grok', stale)
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const continued = await continueRun(root, 'finish', limit)
    expect(error.mock.calls.flat().join(' ')).toContain(`newest turn ${stale} recorded no session id`)
    error.mockRestore()
    expect(db().query('SELECT parent_run_id,vendor_session FROM run WHERE id=?').get(continued.childId))
      .toEqual({ parent_run_id: root, vendor_session: 'parent-session' })
  })

  test('a checkpoint continues in a fresh vendor turn with or without a recorded session', async () => {
    for (const vendorSession of [null, 'old-session']) {
      const root = insert('ok')
      const prompt = trackResidue(join(dir, `checkpoint-root-${root}.prompt.txt`))
      writeFileSync(prompt, 'the root checkpoint spec')
      db().query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE id=?')
        .run(vendorSession, 'codex', prompt, 'orch-test-session', root)
      db().query(
        `INSERT INTO run_checkpoint (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
         VALUES (?,1,?,'item 1',1,?)`,
      ).run(root, 'a'.repeat(40), new Date().toISOString())
      const continued = await continueRun(root, 'caller follow-up', limit)
      const child = db().query(
        'SELECT parent_run_id,turn,vendor_session,prompt_path FROM run WHERE id=?',
      ).get(continued.childId) as { parent_run_id: number; turn: number; vendor_session: string | null; prompt_path: string }
      expect(child).toMatchObject({ parent_run_id: root, turn: 2 })
      expect(child.vendor_session).not.toBe('old-session')
      expect(readFileSync(child.prompt_path, 'utf8')).toContain('CHECKPOINT RESUME')
      expect(readFileSync(child.prompt_path, 'utf8')).toContain('the root checkpoint spec')
      expect(readFileSync(child.prompt_path, 'utf8')).toContain('caller follow-up')
    }
  })

  test('continue --file refuses when a just-below-limit body plus the reminder exceeds argv', async () => {
    const root = insert('ok')
    const longSpec = 's'.repeat(600)
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', 'x'))
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = trackResidue(join(dir, `continue-long-${root}.prompt.txt`))
    writeFileSync(spec, longSpec)
    db().query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE id=?')
      .run('parent-session', 'codex', spec, 'orch-test-session', root)
    const assembled = Buffer.byteLength(packedResumePrompt('file-question', body, root))
    await expect(continueRun(root, body, limit)).rejects.toThrow(`assembled resume prompt is ${assembled} bytes`)
    expect(db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root)).toEqual({ n: 0 })
  })

  test('continue --file accepts the same body when the reminder is short', async () => {
    const root = insert('ok')
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', 'x'))
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = trackResidue(join(dir, `continue-short-${root}.prompt.txt`))
    writeFileSync(spec, 'x')
    db().query('UPDATE run SET vendor_session=?,agent=?,prompt_path=?,session_id=? WHERE id=?')
      .run('parent-session', 'codex', spec, 'orch-test-session', root)
    const continued = await continueRun(root, body, limit)
    const child = db().query('SELECT prompt_path,parent_run_id FROM run WHERE id=?').get(continued.childId) as
      { prompt_path: string; parent_run_id: number }
    expect(child.parent_run_id).toBe(root)
    expect(readFileSync(child.prompt_path, 'utf8')).toBe(body)
  })

  test('continuing an unowned root adopts it before linking the child', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-A'
    const root = insert('failed', 'implement')
    db().query('UPDATE run SET session_id=NULL,vendor_session=?,agent=?,cwd=? WHERE id=?')
      .run('unowned-vendor-session', 'codex', dir, root)
    const continued = await continueRun(root, 'continue adoption fixture', limit)
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(root)).toEqual({ session_id: 'session-A' })
    expect(db().query('SELECT session_id,parent_run_id FROM run WHERE id=?').get(continued.childId))
      .toEqual({ session_id: 'session-A', parent_run_id: root })
    expect(db().query(
      'SELECT action,actor_session,reason FROM run_mutation_audit WHERE root_id=? ORDER BY rowid',
    ).all(root)).toEqual([
      { action: 'adopt', actor_session: 'session-A', reason: 'before continue' },
      { action: 'continue', actor_session: 'session-A', reason: 'continue adoption fixture' },
    ])
  })
})
