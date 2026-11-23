import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { AgentRow } from './agent-registry.ts'
import { shareAgent, sharedAgentDeclaration, unshareAgent } from './agent-share.ts'

const hostedSpaceId = '01990000-0000-7000-8000-000000000248'

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

test('shared declaration carries every declared field and no machine state', () => {
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
  })
  expect(declaration).not.toHaveProperty('enabled')
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
      `agent "not-a-local-agent" is not declared in space "shared-agents"; run \`${PLATFORM_SLUG} agent share not-a-local-agent --space shared-agents\` to declare it, or the declaration may already be absent`,
    )
  })
})
