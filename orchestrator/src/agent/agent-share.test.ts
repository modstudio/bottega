import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordSpaceMembershipRefusal } from '../../../shared/record-remedies.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { registerRecordRequestSpace } from '../record/record-api-request-space.ts'
import type { RecordIdentity } from '../record/record-auth.ts'
import type { AgentRow } from './agent-registry.ts'
import {
  listSharedAgents,
  shareAgent,
  shareAllAgents,
  sharedAgentDeclaration,
  unshareAgent,
} from './agent-share.ts'

const hostedSpaceId = '01990000-0000-7000-8000-000000000248'
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL

afterEach(() => {
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
})

function spaceAgentClient(removed: boolean): RecordApiClient {
  return {
    whoami: async () => ({
      personalSpaceId: null,
      memberships: [{ space_id: hostedSpaceId, slug: 'shared-agents', permission: 'write' }],
    }),
    deleteSpaceAgent: async () => ({ removed }),
  } as unknown as RecordApiClient
}

async function withHostedRecord<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previous
  }
}

test('shared declaration carries declared enablement but no probe state', () => {
  const declaration = sharedAgentDeclaration({
    name: 'codex',
    harness: 'codex',
    backend: 'vendor',
    model: 'gpt-6.2-sol',
    base_url: null,
    api_key_secret: 'OPENAI_API_KEY',
    provider: 'openai',
    request_settings: '{"reasoning":"high"}',
    transport: 'cli',
    caps: '{"readsRepo":true}',
    billing: 'subscription',
    operated_by: 'vendor',
    enabled: 0,
    disabled_reason: 'machine-only',
    probed_at: '2026-11-23T00:00:00Z',
    probe_result: '{"ok":true}',
    jobs: '["implement"]',
    preferred_jobs: '["implement"]',
    max_concurrent: 2,
    route_metered: 0,
    trains_on_inputs: 0,
  } satisfies AgentRow)
  expect(declaration).toEqual({
    name: 'codex',
    harness: 'codex',
    backend: 'vendor',
    model: 'gpt-6.2-sol',
    baseUrl: null,
    apiKeySecret: 'OPENAI_API_KEY',
    provider: 'openai',
    requestSettings: { reasoning: 'high' },
    transport: 'cli',
    billing: 'subscription',
    operatedBy: 'vendor',
    jobs: ['implement'],
    preferredJobs: ['implement'],
    maxConcurrent: 2,
    routeMetered: false,
    trainsOnInputs: false,
    enabled: false,
    disabledReason: 'machine-only',
  })
  expect(declaration).not.toHaveProperty('caps')
  expect(declaration).not.toHaveProperty('probeResult')
})

test('share refusal names an unknown local agent and the listing remedy', async () => {
  await withHostedRecord(async () => {
    await expect(
      shareAgent('not-a-local-agent', 'shared-agents', spaceAgentClient(true)),
    ).rejects.toThrow(
      `unknown local agent "not-a-local-agent"; run \`${PLATFORM_SLUG} agent list\` to list local agents`,
    )
  })
})

test('share all continues after a failed declaration and reports every local row', async () => {
  await withHostedRecord(async () => {
    const client = {
      whoami: async () => ({ personalSpaceId: null, memberships: [] }),
      upsertSpaceAgent: async (declaration: { name: string }) => {
        if (declaration.name === 'codex') throw new Error('record unavailable for codex')
        return declaration
      },
    } as unknown as RecordApiClient
    const results = await shareAllAgents('shared-agents', client)

    expect(results.find(({ name }) => name === 'codex')).toEqual({
      name: 'codex',
      error: 'record unavailable for codex',
    })
    expect(results.some((result) => result.declaration !== undefined)).toBe(true)
  })
})

test('unshare withdraws a declaration without requiring a local agent row', async () => {
  await withHostedRecord(async () => {
    await expect(
      unshareAgent('not-a-local-agent', 'shared-agents', spaceAgentClient(true)),
    ).resolves.toBeUndefined()
  })
})

test('unshare refusal names the space, agent, and restoration remedy', async () => {
  await withHostedRecord(async () => {
    await expect(
      unshareAgent('not-a-local-agent', 'shared-agents', spaceAgentClient(false)),
    ).rejects.toThrow(
      `agent "not-a-local-agent" is not declared in space "shared-agents"; run \`${PLATFORM_SLUG} agent share 'not-a-local-agent' --space 'shared-agents'\` to declare it, or the declaration may already be absent`,
    )
  })
})

test('space-agent route refuses a non-member space with the membership remedy', async () => {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      user: { id: 'user-a', email: 'a@example.test' },
      activeSpaceId: hostedSpaceId,
      personalSpaceId: null,
      memberships: [
        {
          space_id: hostedSpaceId,
          name: 'Shared Agents',
          slug: 'shared-agents',
          role: 'member',
          permission: 'write',
        },
      ],
    })
    return next()
  })
  registerRecordRequestSpace(app)
  app.put('/v1/space-agents', (context) => context.json({ ok: true }))

  const response = await app.request('/v1/space-agents', {
    method: 'PUT',
    headers: { 'x-record-space': 'outside-space' },
  })
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    error: 'signed-in user is not a member of record space outside-space',
    remedy: recordSpaceMembershipRefusal('outside-space'),
  })
})

describe('on a local-only install', () => {
  beforeEach(() => {
    delete process.env.BOTTEGA_RECORD_API_URL
  })

  test('share, unshare, and list refuse with the hosted-record remedy', async () => {
    const client = spaceAgentClient(true)

    await expect(shareAgent('not-a-local-agent', 'shared-agents', client)).rejects.toThrow(
      `no hosted record is configured for this install; run \`${PLATFORM_SLUG} record use <address>\` before running \`${PLATFORM_SLUG} agent share\``,
    )
    await expect(unshareAgent('not-a-local-agent', 'shared-agents', client)).rejects.toThrow(
      `no hosted record is configured for this install; run \`${PLATFORM_SLUG} record use <address>\` before running \`${PLATFORM_SLUG} agent unshare\``,
    )
    await expect(listSharedAgents('shared-agents', client)).rejects.toThrow(
      `no hosted record is configured for this install; run \`${PLATFORM_SLUG} record use <address>\` before running \`${PLATFORM_SLUG} agent list\``,
    )
  })
})
