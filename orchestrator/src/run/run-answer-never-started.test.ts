import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  answerRunFlags as flags,
  answerRunHelpers as helpers,
} from '../../test/fixtures/run-answer.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { retryRun } from './run-answer.ts'
import type { detach } from './run-dispatch.ts'

const trackResidue = trackedTestResidue()
const priorSession = process.env.CLAUDE_CODE_SESSION_ID
afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

test('retry dispatches a never-started readless run from the caller cwd', async () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  const id = addRun({ agent: '(pending)', job: 'summarize', status: 'failed', kind: 'capacity' })
  const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
  writeFileSync(prompt, 'Summarize this conversation')
  db()
    .query('UPDATE run SET prompt_path=?,session_id=? WHERE record_id=?')
    .run(prompt, 'orch-test-session', id)
  let dispatched: Parameters<typeof detach>[2] | undefined
  const dispatch: typeof detach = async (_job, _prompt, spec) => {
    dispatched = spec
    return addRun({ agent: 'grok', job: 'summarize', status: 'ok' })
  }

  await retryRun(id, { flags }, { ...helpers, dispatch })

  expect(dispatched).toMatchObject({ cwd: process.cwd(), agent: undefined, resume: undefined })
})
