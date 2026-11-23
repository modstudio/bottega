import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  type RecordSpaceAgentEnvironment,
  registerRecordSpaceAgentRoutes,
} from './record-api-space-agents.ts'
import type { RecordSpaceAgent } from './record-space-agents.ts'

const declaration = (model = 'gpt-6.2-sol'): RecordSpaceAgent => ({
  name: 'codex',
  harness: 'codex',
  backend: 'vendor',
  model,
  baseUrl: null,
  transport: 'cli',
  provider: 'openai',
  apiKeySecret: 'OPENAI_API_KEY',
  requestSettings: { reasoning: 'high' },
  jobs: ['implement'],
  preferredJobs: ['implement'],
  maxConcurrent: 2,
  routeMetered: false,
  trainsOnInputs: false,
  operatedBy: 'vendor',
  billing: 'subscription',
})

test('space agent routes share, replace, list, and unshare declarations', async () => {
  const rows = new Map<string, RecordSpaceAgent>()
  const app = new Hono<RecordSpaceAgentEnvironment>()
  registerRecordSpaceAgentRoutes(
    app,
    {
      readSpaceAgents: async () => [...rows.values()],
      upsertSpaceAgent: async (input) => {
        const { url: _, userId: __, spaceId: ___, spaceIds: ____, ...row } = input
        rows.set(row.name, row)
        return row
      },
      deleteSpaceAgent: async ({ name }) => ({ removed: rows.delete(name) }),
    },
    {
      scope: () => ({
        url: 'postgres://record',
        userId: 'user',
        spaceId: 'space',
        spaceIds: ['space'],
      }),
      noSpace: () => new Response('missing space', { status: 409 }),
    },
  )
  const request = (method: string, body?: unknown) =>
    app.request('/v1/space-agents', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  expect((await request('PUT', declaration())).status).toBe(200)
  expect(await (await request('GET')).json()).toEqual([declaration()])
  expect((await request('PUT', declaration('replacement-model'))).status).toBe(200)
  expect(await (await request('GET')).json()).toEqual([declaration('replacement-model')])
  expect(rows).toHaveLength(1)
  expect(await (await request('DELETE', { name: 'codex' })).json()).toEqual({ removed: true })
  expect(await (await request('DELETE', { name: 'codex' })).json()).toEqual({ removed: false })
})

test('space agent route rejects machine-state fields', async () => {
  const app = new Hono<RecordSpaceAgentEnvironment>()
  registerRecordSpaceAgentRoutes(
    app,
    {
      readSpaceAgents: async () => [],
      upsertSpaceAgent: async (input) => input,
      deleteSpaceAgent: async () => ({ removed: false }),
    },
    {
      scope: () => ({
        url: 'postgres://record',
        userId: 'user',
        spaceId: 'space',
        spaceIds: ['space'],
      }),
      noSpace: () => new Response('missing space', { status: 409 }),
    },
  )
  const response = await app.request('/v1/space-agents', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...declaration(), enabled: true }),
  })
  expect(response.status).toBe(400)
})
