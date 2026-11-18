import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { assertWorkerText, readMessageText, readWorkerFile } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
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
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
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
  const baseCommit = gitContext(process.cwd(), 'rev-parse', '--verify', 'HEAD')!
  writeFileSync(prompt, 'Review this change.')
  db()
    .query(
      "UPDATE run SET prompt_path=?,cwd=?,base_commit=?,session_id=?,transport='acp',agent_explicit=1 WHERE record_id=?",
    )
    .run(prompt, dir, baseCommit, 'orch-test-session', id)
  const dispatch: typeof detach = async (job, _prompt, spec) => {
    assertAcpAllowed(job, spec.agent, undefined, Boolean(spec.agentExplicit))
    return addRun({ agent: spec.agent!, job, status: 'ok', session: 'orch-test-session' })
  }

  await expect(retryRun(id, { flags }, { ...helpers, dispatch })).resolves.toBeUndefined()
})

test('retry with the same agent carries the chain transport', async () => {
  const id = addRun({
    agent: 'grok',
    job: 'file-question',
    status: 'failed',
    repo: 'continuation-fixture',
  })
  const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
  const baseCommit = gitContext(process.cwd(), 'rev-parse', '--verify', 'HEAD')!
  writeFileSync(prompt, 'What does bar.ts do?')
  db()
    .query(
      "UPDATE run SET prompt_path=?,cwd=?,base_commit=?,session_id=?,transport='acp' WHERE record_id=?",
    )
    .run(prompt, dir, baseCommit, 'orch-test-session', id)
  const dispatched: Parameters<typeof detach>[2][] = []
  const dispatch: typeof detach = async (job, _prompt, spec) => {
    dispatched.push(spec)
    return addRun({ agent: spec.agent!, job, status: 'ok', session: 'orch-test-session' })
  }

  await retryRun(id, { flags }, { ...helpers, dispatch })

  expect(dispatched[0]?.transport).toBe('acp')
})
