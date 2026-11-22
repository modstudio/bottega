import { afterEach, expect, test } from 'bun:test'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import {
  createMemoryRecordApiClient,
  idleRecordApiDeps,
  idleSubjectDeps,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { hostedDocClient } from '../doc/doc-hosted-client.ts'
import { recordApiClientOver } from './record-api-client.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import { identity } from './record-api-identity.fixture.ts'
import type { RecordDocRevision } from './record-doc-mapping.ts'

const contractRoutes = ['GET /v1/doc-revisions/:revisionId'] as const

const revisionId = '01990000-0000-7000-8000-000000000501'

function revisionWithBody(body: string): RecordDocRevision {
  return {
    id: revisionId,
    docId: '01990000-0000-7000-8000-000000000502',
    scope: 'global',
    subject: null,
    owner: null,
    slug: 'revision-contract',
    op: 'set',
    title: 'Revision contract',
    body,
    withheldForAudience: false,
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 0,
    author: 'fixture',
    authorName: null,
    reason: 'fixture revision',
    sessionId: null,
    at: '2026-11-22T00:00:00.000Z',
  }
}

afterEach(() => installRecordApiClient(createMemoryRecordApiClient()))

test('a revision outside the caller readable spaces is not found', async () => {
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      readDocRevision: async (input: { spaceIds: string[] }) =>
        input.spaceIds.includes('space-b') ? revisionWithBody('secret') : null,
    },
  )

  const response = await app.request(`/v1/doc-revisions/${revisionId}`)
  expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toContain(contractRoutes[0])
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'doc revision not found' })
})

test('a revision in a readable space is returned with its body', async () => {
  const revision = revisionWithBody('readable revision body')
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      readDocRevision: async (input: { spaceIds: string[] }) =>
        input.spaceIds.includes('space-a') ? revision : null,
    },
  )

  const response = await app.request(`/v1/doc-revisions/${revisionId}`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(revision)
})

test('the hosted document client reads a revision across readable spaces without a destination', async () => {
  const revision = revisionWithBody('readable revision body')
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    { readDocRevision: async () => revision },
  )
  const request: RecordClientRequest = async <T>(
    path: string,
    init: Parameters<RecordClientRequest>[1] = {},
  ): Promise<T> => {
    const {
      destinationSpaceId,
      schema: _schema,
      acceptedError: _acceptedError,
      ...requestInit
    } = init
    const headers = recordRequestHeaders({
      destinationSpaceId,
      headers: init.headers,
    })
    const response = await app.request(path, { ...requestInit, headers })
    const body = await response.json()
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`)
    return body as T
  }
  installRecordApiClient(recordApiClientOver(request))

  const result = await (await hostedDocClient('global', null)).getDocRevision(revisionId)
  expect(result).toEqual(revision)
})
