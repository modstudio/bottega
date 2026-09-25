import { describe, expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { importCanon } from './canon-import.ts'
import { listDocs } from './docs.ts'

const owner = '01990000-0000-7000-8000-000000000091'

test('a hosted batch failure leaves every local user canon row unchanged', async () => {
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
})

describe.each([
  ['project', { kind: 'project', subject: 'history-project' } as const],
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
