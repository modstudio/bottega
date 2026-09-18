import { expect, test } from 'bun:test'
import { type AgentRow, addAgent, refreshAgents, removeAgent } from './agent-registry.ts'
import {
  readModelHostEnvironment,
  registeredContextTokens,
  registeredLocalAgent,
  unavailableReason,
} from './model-host.ts'

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

for (const [name, legacyName] of [
  ['ORCH_MODEL_HOST_URL', 'ORCH_LOCAL_BASE_URL'],
  ['ORCH_MODEL_HOST_MODEL', 'ORCH_LOCAL_MODEL'],
  ['ORCH_MODEL_HOST_WOL_MAC', 'ORCH_LOCAL_WOL_MAC'],
] as const) {
  test(`${name} supports the legacy-to-new migration matrix`, () => {
    const warnings: string[] = []
    const warned = new Set<string>()
    const read = (env: NodeJS.ProcessEnv) =>
      readModelHostEnvironment(env, name, legacyName, (warning) => warnings.push(warning), warned)

    expect(read({ [legacyName]: 'legacy' })).toBe('legacy')
    expect(read({ [name]: 'new' })).toBe('new')
    expect(read({ [name]: 'new', [legacyName]: 'legacy' })).toBe('new')
    expect(read({ [legacyName]: 'legacy-again' })).toBe('legacy-again')
    expect(warnings).toEqual([`${legacyName} is deprecated; use ${name}`])
  })
}
