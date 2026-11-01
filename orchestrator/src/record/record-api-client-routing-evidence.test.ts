import { expect, test } from 'bun:test'
import { recordRoutingEvidenceClient } from './record-api-client-routing-evidence.ts'

test('routing evidence client carries the space and incremental cursor query', async () => {
  const paths: string[] = []
  const client = recordRoutingEvidenceClient(async (path) => {
    paths.push(path)
    return { items: [], nextCursor: null }
  })
  expect(
    await client.listRoutingEvidence({
      spaceId: '01990000-0000-7000-8000-000000002013',
      limit: 50,
      cursor: 'next-page',
    }),
  ).toEqual({ items: [], nextCursor: null })
  expect(paths).toEqual([
    '/v1/routing-evidence?spaceId=01990000-0000-7000-8000-000000002013&limit=50&cursor=next-page',
  ])
})
