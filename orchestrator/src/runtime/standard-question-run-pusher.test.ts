import { afterEach, beforeEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { localOutbox, options } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { resolveQuestionRunPusher } from '../question-store/question-run-pusher.ts'
import { registerStandardQuestionRunPusher } from './standard-question-run-pusher.ts'

let previousRecordApiUrl: string | undefined

beforeEach(() => {
  previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  registerStandardQuestionRunPusher()
})

afterEach(() => {
  installRecordApiClient(null)
  if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
})

test('standard question run pusher syncs the run before returning', async () => {
  const database = localOutbox(1, null)
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    ...options(database, fakePostgres()).client,
  })
  const runId = database
    .query<{ row_id: string }, []>("SELECT row_id FROM outbox WHERE kind='run'")
    .get()!.row_id
  await resolveQuestionRunPusher()(database, runId)
  expect(
    database.query<{ synced_at: string | null }, []>('SELECT synced_at FROM outbox').get()!
      .synced_at,
  ).not.toBeNull()
  database.close()
})

test('standard question run pusher refuses when sync leaves the run pending', async () => {
  const database = localOutbox(1, null)
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    sync: async (request) => ({
      results: request.rows.map((row) => ({
        id: row.id,
        status: 'deferred' as const,
        reason: 'fixture hold',
        spaceId: '01990000-0000-7000-8000-000000000001',
      })),
    }),
  })
  const runId = database
    .query<{ row_id: string }, []>("SELECT row_id FROM outbox WHERE kind='run'")
    .get()!.row_id
  await expect(resolveQuestionRunPusher()(database, runId)).rejects.toThrow(
    `run ${runId} did not reach the hosted record; run \`${PLATFORM_SLUG} record sync\``,
  )
  expect(
    database.query<{ synced_at: string | null }, []>('SELECT synced_at FROM outbox').get()!
      .synced_at,
  ).toBeNull()
  database.close()
})
