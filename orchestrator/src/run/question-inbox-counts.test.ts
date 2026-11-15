import { beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { questionInboxCountsForSession } from './question-inbox-counts.ts'

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'session-a'
})

function addQuestion(run: string, awaitingOperator = false) {
  db()
    .query(
      `INSERT INTO question
       (number,record_id,run_record_id,asked_at,question,awaiting_operator_at)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'Which?',?)`,
    )
    .run(newRecordId(), run, new Date().toISOString(), awaitingOperator ? '2026-11-15' : null)
}

test('counts only live inbox rows through their shared groups', async () => {
  const worker = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'session-a',
  })
  const user = addRun({ agent: 'codex', job: 'implement', status: 'asking', session: 'session-a' })
  const foreign = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'asking',
    session: 'session-b',
  })
  const unowned = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const dead = addRun({ agent: 'codex', job: 'implement', status: 'stopped', session: 'session-a' })
  addQuestion(worker)
  addQuestion(user, true)
  addQuestion(foreign)
  addQuestion(unowned)
  addQuestion(dead)

  expect(await questionInboxCountsForSession('session-a')).toEqual({
    worker: 1,
    user: 1,
    foreign: 1,
    unowned: 1,
  })
})

test('returns null when the inbox cannot be read', async () => {
  expect(await questionInboxCountsForSession('session-a', new Database(':memory:'))).toBeNull()
})
