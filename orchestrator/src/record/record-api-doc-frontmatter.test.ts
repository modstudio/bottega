import { expect, test } from 'bun:test'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import {
  DOC_FRONTMATTER_ONLY_MAX_PREFIX_CHARACTERS,
  DOC_FRONTMATTER_ONLY_MAX_PREFIXES,
} from './record-api-doc-list.ts'
import { identity } from './record-api-identity.fixture.ts'

test('doc lists validate and forward repeatable frontmatter-only prefixes', async () => {
  const seen: string[][] = []
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      listDocs: async (input: { frontmatterOnly?: string[] }) => {
        seen.push(input.frontmatterOnly ?? [])
        return []
      },
    },
  )
  const accepted = await app.request(
    '/v1/docs?frontmatterOnly=.agents%2Fcontexts%2F&frontmatterOnly=.agents%2Freference%2F',
  )
  expect(accepted.status).toBe(200)
  expect(seen).toEqual([['.agents/contexts/', '.agents/reference/']])

  const tooMany = new URLSearchParams()
  for (let index = 0; index <= DOC_FRONTMATTER_ONLY_MAX_PREFIXES; index++)
    tooMany.append('frontmatterOnly', `prefix-${index}`)
  const tooManyResponse = await app.request(`/v1/docs?${tooMany}`)
  expect(tooManyResponse.status).toBe(400)
  expect(await tooManyResponse.json()).toEqual({
    error: `frontmatterOnly accepts at most ${DOC_FRONTMATTER_ONLY_MAX_PREFIXES} prefixes`,
  })

  const tooLong = 'x'.repeat(DOC_FRONTMATTER_ONLY_MAX_PREFIX_CHARACTERS + 1)
  const tooLongResponse = await app.request(
    `/v1/docs?frontmatterOnly=${encodeURIComponent(tooLong)}`,
  )
  expect(tooLongResponse.status).toBe(400)
  expect(await tooLongResponse.json()).toEqual({
    error: `frontmatterOnly prefix length limit is 1-${DOC_FRONTMATTER_ONLY_MAX_PREFIX_CHARACTERS} characters`,
  })
  const emptyResponse = await app.request('/v1/docs?frontmatterOnly=')
  expect(emptyResponse.status).toBe(400)
  expect(await emptyResponse.json()).toEqual({
    error: `frontmatterOnly prefix length limit is 1-${DOC_FRONTMATTER_ONLY_MAX_PREFIX_CHARACTERS} characters`,
  })
})
