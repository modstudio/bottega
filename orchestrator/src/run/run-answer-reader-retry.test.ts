import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  answerRunFlags as flags,
  answerRunHelpers as helpers,
} from '../../test/fixtures/run-answer.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { retryRun } from './run-answer.ts'
import type { detach } from './run-dispatch.ts'

const trackResidue = trackedTestResidue()
let priorSession: string | undefined

beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'continuation-fixture', path: process.cwd() })
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

test('retry provisions a fresh reader from its original launch cwd and recorded base', async () => {
  const id = addRun({
    agent: 'grok',
    job: 'file-question',
    status: 'failed',
    session: 'orch-test-session',
    repo: 'continuation-fixture',
  })
  const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
  const baseCommit = gitContext(process.cwd(), 'rev-parse', '--verify', 'HEAD')!
  const originalLaunchCwd = join(dir, `original-launch-${id}`)
  writeFileSync(prompt, 'What does bar.ts do?')
  db()
    .query(
      'UPDATE run SET prompt_path=?,cwd=?,worktree=?,base_commit=?,launch_cwd=?,launch_base=? WHERE record_id=?',
    )
    .run(prompt, dir, dir, baseCommit, originalLaunchCwd, baseCommit, id)
  const dispatched: Parameters<typeof detach>[2][] = []
  const dispatch: typeof detach = async (_job, _prompt, spec) => {
    dispatched.push(spec)
    return addRun({ agent: 'grok', job: 'file-question', status: 'ok' })
  }

  await retryRun(id, { flags }, { ...helpers, dispatch })

  expect(dispatched[0]).toMatchObject({
    cwd: originalLaunchCwd,
    base: undefined,
    launchBase: undefined,
    resume: { kind: 'retry-root', parent: id, worktree: null, readOnlyBase: baseCommit },
  })
})
