import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import type { SecretScanner } from '../secret-scan/secret-scan.ts'
import { importCanon } from './canon-import.ts'
import { DOC_SECRET_SCANNER_KEY } from './doc-secret-scan.ts'
import { getDoc, listDocs } from './docs.ts'

const owner = '01990000-0000-7000-8000-000000000091'
const scannerHolder = globalThis as typeof globalThis & {
  [DOC_SECRET_SCANNER_KEY]?: SecretScanner
}

afterEach(() => {
  scannerHolder[DOC_SECRET_SCANNER_KEY] = () => ({ status: 'clean' })
  delete process.env.BOTTEGA_RECORD_API_URL
})

test('a finding in one row refuses the whole canon import before either store is written', async () => {
  let hostedWrites = 0
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    importCanon: async (input) => {
      hostedWrites++
      return client.importCanon(input)
    },
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  scannerHolder[DOC_SECRET_SCANNER_KEY] = (body) =>
    body === 'secret body'
      ? {
          status: 'found',
          findings: [{ ruleId: 'github-pat', line: 4 }],
        }
      : { status: 'clean' }

  await expect(
    importCanon({
      address: { kind: 'user', owner },
      reason: 'refuse secret-bearing import',
      rows: [
        { slug: 'AGENTS.md', title: 'AGENTS.md', body: 'clean body' },
        { slug: '.agents/rules/secret.md', title: 'secret.md', body: 'secret body' },
      ],
    }),
  ).rejects.toThrow('secret scan refused canon/_/.agents/rules/secret.md: github-pat at line 4')
  expect(listDocs({ scope: 'canon', subject: null, owner })).toEqual([])
  expect(hostedWrites).toBe(0)
})

test('an unavailable canon scanner writes all rows and returns one warning', async () => {
  scannerHolder[DOC_SECRET_SCANNER_KEY] = () => ({
    status: 'unavailable',
    reason: 'gitleaks timed out',
  })

  const result = await importCanon({
    address: { kind: 'user', owner },
    reason: 'allow unchecked import',
    rows: [
      { slug: 'AGENTS.md', title: 'AGENTS.md', body: 'first body' },
      { slug: '.agents/rules/second.md', title: 'second.md', body: 'second body' },
    ],
  })

  expect(result.writeWarnings).toEqual([
    'secret scan could not run for canon/_/AGENTS.md: gitleaks timed out; write allowed unchecked',
  ])
  expect(listDocs({ scope: 'canon', subject: null, owner })).toHaveLength(2)
})

test('a hosted batch failure leaves every local user canon row unchanged', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const first = await setDoc({
    scope: 'canon',
    subject: null,
    owner,
    slug: 'AGENTS.md',
    title: 'AGENTS.md',
    body: 'Current entry.',
    allowCanonBootstrap: true,
  })
  const second = await setDoc({
    scope: 'canon',
    subject: null,
    owner,
    slug: '.agents/rules/current.md',
    title: '.agents/rules/current.md',
    body: '---\ndescription: Current\nalways: true\n---\n\nCurrent rule.\n',
    allowCanonBootstrap: true,
  })
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    importCanon: async () => {
      throw new Error('hosted batch refused')
    },
  })

  await expect(
    importCanon({
      address: { kind: 'user', owner },
      reason: 'test atomic import',
      rows: [{ slug: 'AGENTS.md', title: 'AGENTS.md', body: 'Changed entry.' }],
    }),
  ).rejects.toThrow('hosted batch refused')
  expect(listDocs({ scope: 'canon', subject: null, owner })).toEqual(
    [first, second].sort((left, right) => left.slug.localeCompare(right.slug)),
  )
  delete process.env.BOTTEGA_RECORD_API_URL
})

test('canon import leaves non-current rows alone and refuses imported-path collisions', async () => {
  installRecordApiClient(createMemoryRecordApiClient())
  const slug = '.agents/rules/draft.md'
  await setDoc({
    scope: 'canon',
    subject: null,
    owner,
    slug,
    title: slug,
    body: '---\ndescription: Draft\nalways: true\n---\n\nDraft rule.\n',
    status: 'draft',
    allowCanonBootstrap: true,
  })

  await importCanon({
    address: { kind: 'user', owner },
    reason: 'import current rows only',
    rows: [{ slug: 'AGENTS.md', title: 'AGENTS.md', body: 'Current entry.' }],
  })
  expect(getDoc('canon', null, slug, owner)?.status).toBe('draft')

  await expect(
    importCanon({
      address: { kind: 'user', owner },
      reason: 'collide with draft',
      rows: [{ slug, title: slug, body: 'Imported body.' }],
    }),
  ).rejects.toThrow(
    new RegExp(
      `is draft and collides.*${PLATFORM_SLUG} doc status.*--status current.*${PLATFORM_SLUG} doc rm`,
      's',
    ),
  )
})

describe.each([
  [
    'project',
    {
      kind: 'project',
      subject: 'history-project',
      projectId: '01990000-0000-7000-8000-000000000001',
    } as const,
  ],
  ['owner', { kind: 'user' } as const],
])('%s canon import history', (_name, address) => {
  test('cannot regain bootstrap after every live row is deleted', async () => {
    const client = createMemoryRecordApiClient()
    const first = await client.importCanon({
      address,
      rows: [{ slug: 'AGENTS.md', title: 'AGENTS.md', body: 'Current rule.' }],
      expectedRevisions: {},
      reason: 'first import',
      author: 'test',
    })
    expect(first.bootstrap).toBe(true)
    await client.deleteDoc(first.rows[0]!.id, {
      reason: 'remove every row',
      author: 'test',
      expectedRevision: first.rows[0]!.revisionId,
    })

    await expect(
      client.importCanon({
        address,
        rows: [{ slug: 'AGENTS.md', title: 'AGENTS.md', body: 'It used to differ.' }],
        expectedRevisions: {},
        reason: 'try bootstrap again',
        author: 'test',
      }),
    ).rejects.toThrow('refusing canon write')
  })

  test('refuses an empty import', async () => {
    const client = createMemoryRecordApiClient()
    await expect(
      client.importCanon({
        address,
        rows: [],
        expectedRevisions: {},
        reason: 'empty import',
        author: 'test',
      }),
    ).rejects.toThrow('refusing empty canon import')
  })
})
