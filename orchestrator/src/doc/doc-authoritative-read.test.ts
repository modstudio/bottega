import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { upsertProject } from '../project/projects.ts'
import { readDoc, readDocRevisions, readDocs } from './doc-authoritative-read.ts'
import { setDocCheckedAgainst } from './docs.ts'

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

const hostedRow = (overrides: Record<string, unknown> = {}) => ({
  id: '01990000-0000-7000-8000-000000000001',
  scope: 'global',
  subject: null,
  owner: null,
  slug: 'authority',
  title: 'Hosted',
  body: 'hosted body',
  delivery: 'demand',
  audiences: ['technical'],
  status: 'current',
  kind: 'working',
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
  ...overrides,
})

test('a hosted read returns the hosted row and never the local mirror', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'authority',
    title: 'Local',
    body: 'local body',
    reason: 'seed a conflicting local mirror',
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  const calls: Array<Parameters<typeof client.listDocs>[0]> = []
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      calls.push(query)
      return {
        items: [
          hostedRow(),
        ],
        nextCursor: null,
      }
    },
  })
  expect((await readDoc('global', null, 'authority'))?.body).toBe('hosted body')
  expect(calls).toEqual([
    {
      scope: 'global',
      subject: null,
      slug: 'authority',
      owner: null,
      audience: undefined,
      acrossReadableSpaces: false,
      limit: 1,
    },
  ])
})

test('a hosted single read refuses a row returned for a different slug', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({ items: [hostedRow({ slug: 'different' })], nextCursor: null }),
  })
  await expect(readDoc('global', null, 'authority')).rejects.toThrow(
    'hosted record API ignored the document filter',
  )
})

test('a hosted project listing without a subject reads all spaces and never the local mirror', async () => {
  upsertProject({ recordId: newRecordId(), name: 'local-project', path: '/tmp/local-project' })
  await setDoc({
    scope: 'project',
    subject: 'local-project',
    slug: 'local-only',
    title: 'Local',
    body: 'local body',
    reason: 'seed a conflicting local mirror',
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  const calls: Array<Parameters<typeof client.listDocs>[0]> = []
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      calls.push(query)
      return {
        items: [hostedRow({ scope: 'project', subject: 'hosted-project' })],
        nextCursor: null,
      }
    },
  })
  expect((await readDocs({ scope: 'project' })).map(({ subject }) => subject)).toEqual([
    'hosted-project',
  ])
  expect(calls).toEqual([
    expect.objectContaining({ scope: 'project', acrossReadableSpaces: true, limit: 100 }),
  ])
})

test('an unqualified hosted read refuses two subjects with the same slug', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      expect(query).toMatchObject({ slug: 'authority', acrossReadableSpaces: true, limit: 2 })
      return {
        items: [
          hostedRow({ scope: 'project', subject: 'one' }),
          hostedRow({
            id: '01990000-0000-7000-8000-000000000002',
            scope: 'project',
            subject: 'two',
          }),
        ],
        nextCursor: null,
      }
    },
  })
  await expect(readDoc('project', undefined, 'authority')).rejects.toThrow(
    'several project docs "authority" match subjects: one, two; pass subject',
  )
})

test('hosted revision listing locates its document with the bounded slug query', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  const calls: Array<Parameters<typeof client.listDocs>[0]> = []
  installRecordApiClient({
    ...client,
    listDocs: async (query) => {
      calls.push(query)
      return { items: [hostedRow()], nextCursor: null }
    },
    listRevisions: async () => [],
  })
  expect(await readDocRevisions('global', null, 'authority')).toEqual([])
  expect(calls).toEqual([
    expect.objectContaining({ scope: 'global', subject: null, slug: 'authority', limit: 1 }),
  ])
})

test('checked-against updates preserve the authoritative hosted body instead of the local mirror', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'checked-project',
    path: '/tmp/checked-project',
    settings: { space: 'checked-space' },
  })
  await setDoc({
    scope: 'project',
    subject: 'checked-project',
    slug: 'checked-hosted',
    title: 'Local title',
    body: 'local stale body',
    kind: 'article',
    form: 'feature',
    audiences: ['technical'],
    reason: 'seed stale mirror',
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  let writtenBody = ''
  installRecordApiClient({
    ...client,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'active-space',
      personalSpaceId: 'active-space',
      memberships: [
        { space_id: 'active-space', slug: 'active', permission: 'write' },
        { space_id: 'checked-space-id', slug: 'checked-space', permission: 'write' },
      ],
    }),
    listDocs: async () => ({
      items: [
        hostedRow({
          scope: 'project',
          subject: 'checked-project',
          slug: 'checked-hosted',
          title: 'Hosted title',
          kind: 'article',
          form: 'feature',
          audiences: ['technical'],
        }),
      ],
      nextCursor: null,
    }),
    upsertDoc: async (input) => {
      writtenBody = input.body
      return { id: String(hostedRow().id), revisionId: '01990000-0000-7000-8000-000000000003' }
    },
  })
  await setDocCheckedAgainst(
    'project',
    'checked-project',
    'checked-hosted',
    '1111111111111111111111111111111111111111',
    { reason: 'mark hosted row checked' },
  )
  expect(writtenBody).toBe('hosted body')
})

test('an unreachable hosted read refuses with the sign-in and retry remedy', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => {
      throw new Error('record unavailable')
    },
  })
  await expect(readDoc('global', null, 'authority')).rejects.toThrow(
    `run ${PLATFORM_SLUG} record whoami to verify sign-in, or retry when the hosted record is reachable`,
  )
})
