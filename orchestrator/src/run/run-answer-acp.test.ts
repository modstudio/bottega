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
import { assertAcpAllowed } from '../transport/transport.ts'
import { retryRun } from './run-answer.ts'
import type { detach } from './run-dispatch.ts'

const trackResidue = trackedTestResidue()
const priorSession = process.env.CLAUDE_CODE_SESSION_ID
const flags = { detach: true, follow: false, quiet: true }
const helpers = {
  argvResumeLimit: () => ARGV_PROMPT_BYTES,
  assertWorkerText,
  readWorkerFile,
  readMessageText,
  presentation: {
    dur: String,
    scoreHint: () => '',
    argvResumeLimit: () => ARGV_PROMPT_BYTES,
    printRunId: () => {},
  },
}

beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: dir })
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})
afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

test('retry of a named ACP review lens is not refused', async () => {
  const id = addRun({
    agent: 'grok',
    job: 'review-lens',
    status: 'failed',
    repo: 'continuation-fixture',
  })
  const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
  writeFileSync(prompt, 'Review this change.')
  db()
    .query(
      "UPDATE run SET prompt_path=?,cwd=?,session_id=?,transport='acp',agent_explicit=1 WHERE record_id=?",
    )
    .run(prompt, dir, 'orch-test-session', id)
  const dispatch: typeof detach = async (job, _prompt, spec) => {
    assertAcpAllowed(job, spec.agent, undefined, Boolean(spec.agentExplicit))
    return addRun({ agent: spec.agent!, job, status: 'ok', session: 'orch-test-session' })
  }

  await expect(retryRun(id, { flags }, { ...helpers, dispatch })).resolves.toBeUndefined()
})
