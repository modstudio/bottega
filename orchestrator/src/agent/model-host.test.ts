import { afterEach, expect, test } from 'bun:test'
import { type AgentRow, addAgent, refreshAgents, removeAgent } from './agent-registry.ts'
import {
  ensureLocalHealth,
  registeredContextTokens,
  registeredLocalAgent,
  unavailableReason,
} from './model-host.ts'

const addedAgents: string[] = []

afterEach(() => {
  for (const name of addedAgents.splice(0)) removeAgent(name)
  refreshAgents()
})

const row = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  name: 'local-acp',
  harness: 'goose',
  backend: 'vllm',
  model: 'operator/model',
  base_url: 'http://127.0.0.1:9000/v1',
  transport: 'acp',
  caps: '{"contextTokens":98304}',
  billing: 'none',
  operated_by: 'self',
  enabled: 1,
  disabled_reason: null,
  probed_at: null,
  probe_result: null,
  jobs: null,
  preferred_jobs: null,
  max_concurrent: null,
  ...overrides,
})

test('local host identity and window come from the matching registry row', () => {
  const registered = registeredLocalAgent([row()], 'http://127.0.0.1:9000/v1')
  expect(registered?.model).toBe('operator/model')
  expect(registeredContextTokens(registered!)).toBe(98_304)
})

test('an absent local registration stays neutral', () => {
  expect(registeredLocalAgent([], '')).toBeNull()
})

test('a missing context window refuses with the command that supplies it', () => {
  addAgent('missing-window', {
    harness: 'goose',
    backend: 'vllm',
    model: 'operator/model',
    baseUrl: 'http://127.0.0.1:9001/v1',
  })
  refreshAgents()
  expect(unavailableReason('missing-window')).toBe(
    'no declared context window; run orch agent set missing-window --context-tokens <tokens>',
  )
  removeAgent('missing-window')
})

test('self-operated agents use the reachability of their own endpoints', async () => {
  for (const [name, baseUrl] of [
    ['reachable-local', 'http://127.0.0.1:19001/v1'],
    ['down-local', 'http://127.0.0.1:19002/v1'],
  ] as const) {
    addAgent(name, {
      harness: 'goose',
      backend: 'vllm',
      model: `operator/${name}`,
      baseUrl,
      contextTokens: 98_304,
    })
    addedAgents.push(name)
  }
  refreshAgents()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.port === '19001') {
      return Response.json({ data: [{ id: 'operator/reachable-local', max_model_len: 98_304 }] })
    }
    throw new Error(`refused ${url.origin}`)
  }) as typeof fetch
  try {
    await ensureLocalHealth({ force: true })
    expect(unavailableReason('reachable-local')).toBeNull()
    expect(unavailableReason('down-local')).toBe(
      'endpoint unreachable — refused http://127.0.0.1:19002',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
