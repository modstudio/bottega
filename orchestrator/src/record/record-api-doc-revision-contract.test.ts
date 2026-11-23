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
import {
  type RecordApiClient,
  type RecordDocUpsertInput,
  recordApiClientOver,
} from './record-api-client.ts'
import { recordApiError } from './record-api-client-error.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import { identity } from './record-api-identity.fixture.ts'
import type { RecordDocRevision } from './record-doc-mapping.ts'

const contractRoutes = ['GET /v1/doc-revisions/:revisionId'] as const

const revisionId = '01990000-0000-7000-8000-000000000501'
const destination = { destinationSpaceId: 'space-a' }

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

function requestOver(app: ReturnType<typeof recordApiTestApp>): RecordClientRequest {
  return async <T>(path: string, init: Parameters<RecordClientRequest>[1] = {}): Promise<T> => {
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
    if (!response.ok) throw recordApiError(body, response.status, response.headers)
    return body as T
  }
}

function memoryDocRouteDeps(memory: RecordApiClient) {
  return {
    async listDocs(
      input: Parameters<RecordApiClient['listDocs']>[0] & {
        spaceId: string
        spaceIds: string[]
        url: string
      },
    ) {
      const { spaceId: _spaceId, spaceIds: _spaceIds, url: _url, ...query } = input
      const page = await memory.listDocs(query)
      return page.items.map((readable) => ({ readable }))
    },
    async readDoc(input: { id: string }) {
      try {
        return await memory.getDoc(input.id)
      } catch {
        return null
      }
    },
    async upsertDoc(
      input: Omit<RecordDocUpsertInput, 'audiences' | 'position'> & {
        spaceId: string
        spaceIds: string[]
        url: string
      },
    ) {
      const { spaceId: _spaceId, spaceIds: _spaceIds, url: _url, ...doc } = input
      return memory.upsertDoc({ ...doc, audiences: ['technical'], position: 0 }, destination)
    },
    async deleteDoc(
      input: Pick<RecordDocUpsertInput, 'reason' | 'author' | 'sessionId' | 'expectedRevision'> & {
        id: string
      },
    ) {
      const { id, ...context } = input
      return memory.deleteDoc(id, context, destination)
    },
  }
}

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
  installRecordApiClient(recordApiClientOver(requestOver(app)))

  const result = await (await hostedDocClient('global', null)).getDocRevision(revisionId)
  expect(result).toEqual(revision)
})

test('document reads return the revision accepted by guarded writes', async () => {
  const memory = createMemoryRecordApiClient()
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    memoryDocRouteDeps(memory),
  )
  const client = recordApiClientOver(requestOver(app))
  const write = (scope: string, slug: string, body: string, expectedRevision?: string) =>
    client.upsertDoc(
      {
        scope,
        subject: null,
        slug,
        title: 'Revision contract',
        body,
        delivery: 'demand',
        audiences: ['technical'],
        position: 0,
        reason: 'exercise guarded write',
        author: 'fixture',
        expectedRevision,
      },
      destination,
    )
  const read = async (scope: string, slug: string) => {
    const page = await client.listDocs({ scope, subject: null, slug }, destination)
    expect(page.items).toHaveLength(1)
    return page.items[0]!
  }

  const created = await write('global', 'revision-contract', 'Created')
  const current = await read('global', 'revision-contract')
  expect(current.latestRevisionId).toBe(created.revisionId)

  const updated = await write(
    'global',
    'revision-contract',
    'Updated',
    String(current.latestRevisionId),
  )
  await expect(
    write('global', 'revision-contract', 'Stale', String(current.latestRevisionId)),
  ).rejects.toMatchObject({ reason: 'stale-revision', currentRevision: updated.revisionId })

  const canonCreated = await write('canon', 'canon-revision-contract', 'Created')
  const canonCurrent = await read('canon', 'canon-revision-contract')
  expect(canonCurrent.latestRevisionId).toBe(canonCreated.revisionId)
  const canonUpdated = await write(
    'canon',
    'canon-revision-contract',
    'Updated',
    String(canonCurrent.latestRevisionId),
  )
  const canonRead = await read('canon', 'canon-revision-contract')
  expect(canonRead.latestRevisionId).toBe(canonUpdated.revisionId)
  await expect(
    client.deleteDoc(
      canonUpdated.id,
      {
        reason: 'exercise guarded remove',
        author: 'fixture',
        expectedRevision: String(canonRead.latestRevisionId),
      },
      destination,
    ),
  ).resolves.toMatchObject({ id: canonUpdated.id })
})
