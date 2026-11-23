import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import {
  readDoc,
  readDocForAudience,
  readDocMetadata,
  readDocReference,
  readDocRevisions,
  readDocs,
} from './doc-authoritative-read.ts'
import { reorderDocs, setDocCheckedAgainst } from './docs.ts'

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
        items: [hostedRow()],
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

test('hosted and local listings without an owner both exclude owned rows', async () => {
  const owner = newRecordId()
  const publicSlug = `.agents/rules/public-${newRecordId()}.md`
  const ownedSlug = `.agents/rules/owned-${newRecordId()}.md`
  await setDoc({
    scope: 'canon',
    subject: null,
    slug: publicSlug,
    title: 'Public',
    body: '---\ndescription: Public\n---\n\nPublic rule.\n',
    reason: 'seed public canon',
    allowCanonBootstrap: true,
  })
  await setDoc({
    scope: 'canon',
    subject: null,
    owner,
    slug: ownedSlug,
    title: 'Owned',
    body: '---\ndescription: Owned\n---\n\nOwned rule.\n',
    reason: 'seed owned canon',
    allowCanonBootstrap: true,
  })
  const local = (await readDocs({ scope: 'canon', subject: null }))
    .map(({ slug }) => slug)
    .filter((slug) => slug === publicSlug || slug === ownedSlug)

  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        hostedRow({ scope: 'canon', slug: publicSlug }),
        hostedRow({ id: newRecordId(), scope: 'canon', owner, slug: ownedSlug }),
      ],
      nextCursor: null,
    }),
  })
  const hosted = (await readDocs({ scope: 'canon', subject: null }))
    .map(({ slug }) => slug)
    .filter((slug) => slug === publicSlug || slug === ownedSlug)

  expect(local).toEqual([publicSlug])
  expect(hosted).toEqual(local)
})

test('a hosted delivery filter excludes rows returned by an older server', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        hostedRow({ delivery: 'inject', slug: 'injected' }),
        hostedRow({ id: newRecordId(), delivery: 'demand', slug: 'on-demand' }),
      ],
      nextCursor: null,
    }),
  })

  expect((await readDocs({ scope: 'global', delivery: 'inject' })).map(({ slug }) => slug)).toEqual(
    ['injected'],
  )
})

test('a missing hosted document reference returns null while server failures still throw', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    getDoc: async () => {
      throw new RecordApiRequestError('doc not found', 'refused', 404)
    },
  })
  await expect(readDocReference(newRecordId(), db())).resolves.toBeNull()

  installRecordApiClient({
    ...client,
    getDoc: async () => {
      throw new RecordApiRequestError('record failed', 'server', 500)
    },
  })
  await expect(readDocReference(newRecordId(), db())).rejects.toThrow('record failed')
})

test('a hosted listing applies the local position order after transport', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        hostedRow({
          slug: 'third',
          title: 'Alpha',
          position: 30,
          updatedAt: '2026-11-23T00:00:00.000Z',
        }),
        hostedRow({
          id: '01990000-0000-7000-8000-000000000002',
          slug: 'first',
          title: 'Zulu',
          position: 10,
        }),
        hostedRow({
          id: '01990000-0000-7000-8000-000000000003',
          slug: 'second',
          title: 'Mike',
          position: 20,
        }),
      ],
      nextCursor: null,
    }),
  })
  expect((await readDocs({ scope: 'global' })).map(({ slug }) => slug)).toEqual([
    'first',
    'second',
    'third',
  ])
  expect(
    (await readDocs({ scope: 'global', updatedAtOrder: 'desc' })).map(({ slug }) => slug),
  ).toEqual(['third', 'first', 'second'])
})

test('hosted metadata derives blank summaries and preserves written summaries', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        hostedRow({ slug: 'null-summary', body: 'Derived from null.', summary: null, position: 1 }),
        hostedRow({
          id: '01990000-0000-7000-8000-000000000002',
          slug: 'blank-summary',
          body: 'Derived from blank.',
          summary: '   ',
          position: 2,
        }),
        hostedRow({
          id: '01990000-0000-7000-8000-000000000003',
          slug: 'written-summary',
          body: 'Ignored body.',
          summary: ' Written summary. ',
          position: 3,
        }),
      ],
      nextCursor: null,
    }),
  })
  expect(
    (await readDocMetadata({ scope: 'global' })).map(({ slug, summary, summarySource }) => ({
      slug,
      summary,
      summarySource,
    })),
  ).toEqual([
    { slug: 'null-summary', summary: 'Derived from null.', summarySource: 'derived' },
    { slug: 'blank-summary', summary: 'Derived from blank.', summarySource: 'derived' },
    { slug: 'written-summary', summary: 'Written summary.', summarySource: 'written' },
  ])
})

test('hosted metadata read failures include the sign-in and retry remedy', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => {
      throw new Error('record unavailable')
    },
  })
  await expect(readDocMetadata({ scope: 'global' })).rejects.toThrow(
    `record unavailable; run ${PLATFORM_SLUG} record whoami to verify sign-in, or retry when the hosted record is reachable`,
  )
})

test('a hosted audience read projects the hosted row body', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        hostedRow({
          audiences: ['customer', 'technical'],
          body: [
            'Shared.',
            '',
            ':::section{audience="customer"}',
            'Customer only.',
            ':::',
            '',
            ':::section{audience="technical"}',
            'Technical only.',
            ':::',
          ].join('\n'),
        }),
      ],
      nextCursor: null,
    }),
  })
  const doc = await readDocForAudience('global', null, 'authority', 'customer')
  expect(doc?.body).toContain('Customer only.')
  expect(doc?.body).not.toContain('Technical only.')
})

test('hosted reorder validates against authoritative siblings when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const parentId = '01990000-0000-7000-8000-000000000010'
  const firstId = '01990000-0000-7000-8000-000000000011'
  const secondId = '01990000-0000-7000-8000-000000000012'
  const client = createMemoryRecordApiClient()
  const writes: string[][] = []
  installRecordApiClient({
    ...client,
    listDocs: async () => ({
      items: [
        hostedRow({ id: firstId, parentId, slug: 'first' }),
        hostedRow({ id: secondId, parentId, slug: 'second' }),
      ],
      nextCursor: null,
    }),
    reorderDocs: async ({ orderedIds }) => {
      writes.push(orderedIds)
      return { orderedIds }
    },
  })
  const input = {
    scope: 'global',
    subject: null,
    parentId,
    orderedIds: [secondId, firstId],
  }
  expect(await reorderDocs(input)).toEqual({ orderedIds: [secondId, firstId] })
  await expect(reorderDocs({ ...input, orderedIds: [firstId] })).rejects.toThrow('missing ids')
  expect(writes).toEqual([[secondId, firstId]])
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
      return {
        id: String(hostedRow().id),
        revisionId: '01990000-0000-7000-8000-000000000003',
        form: 'feature',
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: [],
        checkedAgainstCommit: '1111111111111111111111111111111111111111',
        summary: null,
      }
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
