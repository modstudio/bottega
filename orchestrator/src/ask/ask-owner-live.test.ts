import { afterEach, expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { RunQuestionOwnerNotLiveError } from '../question-store/run-question-write-guard.ts'
import { identity } from '../record/record-api-identity.fixture.ts'
import { ask } from './ask.ts'

afterEach(() => {
  installRecordApiClient(null)
  delete process.env.BOTTEGA_RECORD_API_URL
})

test('ask refuses a locally superseded turn before a hosted write', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  let writes = 0
  const client = createMemoryRecordApiClient()
  db().query("UPDATE project SET settings=json_set(settings,'$.space','space-a')").run()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  installRecordApiClient({
    ...client,
    whoami: async () => identity,
    writeQuestion: async (_intent, body) => {
      writes += 1
      return { id: body.question.id, number: 1, revision: body.question.revision, applied: true }
    },
  })

  const result = await ask({
    runId,
    question: 'Which implementation?',
    why: 'The implementation depends on the ruling.',
    timeoutMs: 1,
  })

  if (result.answered) throw new Error('superseded turn unexpectedly received a ruling')
  expect(result.reason).toMatch(/turn was superseded or finished.*must stop/)
  expect(writes).toBe(0)
  expect(
    db().query('SELECT COUNT(*) count FROM question WHERE run_record_id=?').get(runId),
  ).toEqual({ count: 0 })
})

test('ask restores running when the hosted store refuses its transition', async () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const client = createMemoryRecordApiClient()
  db().query("UPDATE project SET settings=json_set(settings,'$.space','space-a')").run()
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  installRecordApiClient({
    ...client,
    whoami: async () => identity,
    writeQuestion: async () => {
      throw new RunQuestionOwnerNotLiveError(runId)
    },
  })

  const result = await ask({
    runId,
    question: 'Which implementation?',
    why: 'The implementation depends on the ruling.',
    timeoutMs: 1,
  })

  if (result.answered) throw new Error('refused question unexpectedly received a ruling')
  expect(result.reason).toMatch(/turn was superseded or finished.*must stop/)
  expect(db().query('SELECT status FROM run WHERE record_id=?').get(runId)).toEqual({
    status: 'running',
  })
})
