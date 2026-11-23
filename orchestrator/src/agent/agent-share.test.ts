import { expect, test } from 'bun:test'
import type { AgentRow } from './agent-registry.ts'
import { sharedAgentDeclaration } from './agent-share.ts'

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
