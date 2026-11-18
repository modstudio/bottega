import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { assertWorkerText, readMessageText, readWorkerFile } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { retryRun } from './run-answer.ts'
import { continueRun } from './run-control.ts'

const priorSession = process.env.CLAUDE_CODE_SESSION_ID
const trackResidue = trackedTestResidue()
const argvResumeLimit = () => ARGV_PROMPT_BYTES
const flags = { detach: true, follow: false, quiet: true }
const helpers = {
  argvResumeLimit,
  assertWorkerText,
  readWorkerFile,
  readMessageText,
  presentation: { dur: String, scoreHint: () => '', argvResumeLimit, printRunId: () => {} },
}

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: dir })
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

test('retry and continue give the same refusal when the chain has no session', async () => {
  for (const command of ['retry', 'continue'] as const) {
    const id = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      repo: 'continuation-fixture',
    })
    const prompt = trackResidue(join(dir, `no-session-${id}.prompt.txt`))
    writeFileSync(prompt, 'continue')
    db()
      .query(
        'UPDATE run SET prompt_path=?,cwd=?,session_id=?,vendor_session=NULL WHERE record_id=?',
      )
      .run(prompt, dir, 'orch-test-session', id)
    const action =
      command === 'retry'
        ? retryRun(id, { flags }, helpers)
        : continueRun(id, 'go', argvResumeLimit)
    await expect(action).rejects.toThrow(
      `run ${id} recorded no session id, so codex cannot be resumed`,
    )
  }
})
