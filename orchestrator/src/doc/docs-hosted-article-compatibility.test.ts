import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { upsertProject } from '../project/projects.ts'
import { getDoc, setDoc } from './docs.ts'

let priorRecordApiUrl: string | undefined

beforeEach(() => {
  priorRecordApiUrl = process.env.ORCH_RECORD_API_URL
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
})

afterEach(() => {
  installRecordApiClient(null)
  if (priorRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = priorRecordApiUrl
})

test('a hosted set that sends an article field refuses before the local commit', async () => {
  upsertProject({ recordId: newRecordId(), name: 'hosted-article', path: '/w/hosted-article' })
  installRecordApiClient(createMemoryRecordApiClient())

  await expect(
    setDoc({
      scope: 'project',
      subject: 'hosted-article',
      slug: 'compatibility',
      title: 'Compatibility',
      body: 'Current.',
      delivery: 'demand',
      kind: 'article',
      audiences: ['technical'],
      sourceFiles: ['src/article.ts'],
      reason: 'prove old API refusal',
    }),
  ).rejects.toThrow('hosted API predates them')
  expect(getDoc('project', 'hosted-article', 'compatibility')).toBeNull()
})

test('a hosted set that sends no article fields accepts an older response', async () => {
  installRecordApiClient(createMemoryRecordApiClient())

  await expect(
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'compatible',
      title: 'Compatible',
      body: 'Current.',
      delivery: 'demand',
      reason: 'prove old API compatibility',
    }),
  ).resolves.toMatchObject({ slug: 'compatible' })
  expect(getDoc('global', null, 'compatible')).not.toBeNull()
})
