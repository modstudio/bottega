import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import {
  answerRunFlags as flags,
  answerRunHelpers as helpers,
  insertRun as insert,
} from '../../test/fixtures/run-answer.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { gitContext } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { recordReview } from '../review/review-triage.ts'
import { retryRun } from './run-answer.ts'
import type { detach } from './run-dispatch.ts'

const trackResidue = trackedTestResidue()
const reviewRef = 'DEV-1702-orch-review-target'
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

function failed(parent?: string): string {
  const id = addRun({
    agent: 'grok',
    job: 'review-lens',
    status: 'failed',
    parent,
    turn: parent ? 2 : 1,
    session: 'orch-test-session',
    repo: parent ? undefined : 'continuation-fixture',
  })
  const prompt = trackResidue(join(dir, `retry-${id}.prompt.txt`))
  writeFileSync(prompt, 'Review the continuation.')
  const baseCommit = gitContext(process.cwd(), 'rev-parse', '--verify', 'HEAD')!
  db()
    .query('UPDATE run SET prompt_path=?,cwd=?,base_commit=? WHERE record_id=?')
    .run(prompt, dir, baseCommit, id)
  return id
}

async function dispatchedReview(id: string): Promise<string | undefined> {
  let review: string | undefined
  const dispatch: typeof detach = async (_job, _prompt, spec) => {
    review = spec.review
    return insert('ok', 'review-lens')
  }
  await retryRun(id, { flags }, { ...helpers, dispatch })
  return review
}

test('retrying a review lens dispatches with its recorded review target', async () => {
  const root = failed()
  db().query('UPDATE run SET review_ref=? WHERE record_id=?').run(reviewRef, root)

  expect(await dispatchedReview(root)).toBe(reviewRef)
})

test('retrying a failed continuation dispatches with the root review target', async () => {
  const root = failed()
  db().query('UPDATE run SET review_ref=? WHERE record_id=?').run(reviewRef, root)

  expect(await dispatchedReview(failed(root))).toBe(reviewRef)
})

test('retrying a supplementary review run preserves the role on its recorded review', async () => {
  const root = failed()
  db()
    .query(
      "UPDATE run SET lens='issue-blast-radius', review_role='supplementary' WHERE record_id=?",
    )
    .run(root)
  let successor: string | null = null
  const dispatch: typeof detach = async (_job, _prompt, spec) => {
    successor = insert('ok', 'review-lens')
    db()
      .query('UPDATE run SET model=?,lens=?,review_role=? WHERE record_id=?')
      .run('m', spec.lens ?? null, spec.reviewRole ?? null, successor)
    return successor
  }

  await retryRun(root, { flags }, { ...helpers, dispatch })
  if (!successor) throw new Error('retry did not dispatch a successor')
  const review = recordReview(successor, reviewReply(0), db())
  expect(db().query('SELECT role FROM review WHERE record_id=?').get(review)).toEqual({
    role: 'supplementary',
  })
})
