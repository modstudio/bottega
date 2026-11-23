import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordSpaceAgentRoutes } from './record-api-space-agents.ts'

const declaration = {
  name: 'codex',
  harness: 'codex',
  backend: 'vendor',
  model: 'gpt-6.2-sol',
  baseUrl: null,
  transport: 'cli',
  provider: null,
  apiKeySecret: 'OPENAI_API_KEY',
  requestSettings: null,
  jobs: null,
  preferredJobs: null,
  maxConcurrent: null,
  routeMetered: false,
  trainsOnInputs: false,
  operatedBy: 'vendor',
  billing: 'subscription',
}

test.each(['GET', 'PUT', 'DELETE'])('%s /v1/space-agents is served', async (method) => {
  const app = new Hono()
  registerRecordSpaceAgentRoutes(
    app,
    {
      readSpaceAgents: async () => [],
      upsertSpaceAgent: async (input) => input,
      deleteSpaceAgent: async () => ({ removed: true }),
    },
    {
      scope: () => ({
        url: 'postgres://record',
        userId: 'user',
        spaceId: 'space',
        spaceIds: ['space'],
      }),
      noSpace: () => new Response(null, { status: 409 }),
    },
  )
  const response = await app.request('/v1/space-agents', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET'
      ? {}
      : { body: JSON.stringify(method === 'PUT' ? declaration : { name: declaration.name }) }),
  })
  expect(response.status).toBe(200)
})
