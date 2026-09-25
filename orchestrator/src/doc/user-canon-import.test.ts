import { expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { listDocs } from './docs.ts'
import { importUserCanon } from './user-canon-import.ts'

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
    importUserCanon: async () => {
      throw new Error('hosted batch refused')
    },
  })

  await expect(
    importUserCanon({
      owner,
      reason: 'test atomic import',
      rows: [{ slug: 'AGENTS.md', title: 'AGENTS.md', body: 'Changed entry.' }],
    }),
  ).rejects.toThrow('hosted batch refused')
  expect(listDocs({ scope: 'canon', subject: null, owner })).toEqual(
    [first, second].sort((left, right) => left.slug.localeCompare(right.slug)),
  )
})
