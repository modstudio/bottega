import { describe, expect, test } from 'bun:test'
import {
  agentsOnBillingCredential,
  agentsOnBillingKey,
  type BillingKeyRun,
  decideBillingKeyHolds,
} from './billing-key-hold.ts'

const agents = [
  { name: 'a', baseUrl: 'https://one.test', apiKeySecret: 'ONE_KEY' },
  { name: 'b', baseUrl: 'https://one.test', apiKeySecret: 'ONE_KEY' },
  { name: 'c', baseUrl: 'https://two.test', apiKeySecret: 'TWO_KEY' },
]
const run = (overrides: Partial<BillingKeyRun>): BillingKeyRun => ({
  record_id: 'a',
  number: 1,
  agent: 'a',
  status: 'failed',
  failure_kind: 'billing',
  endpoint_key_source: 'agent',
  credential_id: null,
  finished_at: 1,
  ...overrides,
})

describe('billing key holds', () => {
  test('billing on one agent holds its sibling but not another key', () => {
    expect(decideBillingKeyHolds(agents, [run({})])).toEqual([
      {
        id: '["ONE_KEY","https://one.test"]',
        secretName: 'ONE_KEY',
        baseUrl: 'https://one.test',
        agents: ['a', 'b'],
        failingRunNumber: 1,
      },
    ])
  })

  test('a later successful probe on a sibling clears the shared hold', () => {
    expect(
      decideBillingKeyHolds(agents, [
        run({}),
        run({
          record_id: 'b',
          number: 2,
          agent: 'b',
          status: 'ok',
          failure_kind: null,
          finished_at: 2,
        }),
      ]),
    ).toEqual([])
  })

  test('a billing failure paid by a project key holds nothing', () => {
    expect(decideBillingKeyHolds(agents, [run({ endpoint_key_source: 'project' })])).toEqual([])
  })

  test('a failed row with no failure kind is a successful answer and clears the hold', () => {
    expect(
      decideBillingKeyHolds(agents, [
        run({}),
        run({
          record_id: 'b',
          number: 2,
          agent: 'b',
          failure_kind: null,
          endpoint_key_source: null,
          finished_at: 2,
        }),
      ]),
    ).toEqual([])
  })

  test('credential billing holds follow the most recent credential id and never legacy groups', () => {
    const providerAgents = [
      { name: 'a', provider: 'openrouter', baseUrl: 'https://one.test', apiKeySecret: 'ONE_KEY' },
      { name: 'b', provider: 'openrouter', baseUrl: 'https://one.test', apiKeySecret: 'ONE_KEY' },
      agents[2]!,
    ]
    expect(
      decideBillingKeyHolds(providerAgents, [
        run({ credential_id: 'credential-a' }),
        run({
          record_id: 'b',
          agent: 'b',
          credential_id: 'credential-a',
          failure_kind: null,
          status: 'ok',
          finished_at: 0,
        }),
      ]),
    ).toEqual([expect.objectContaining({ id: 'credential:credential-a', agents: ['a', 'b'] })])
    expect(decideBillingKeyHolds(providerAgents, [run({ credential_id: null })])).toEqual([])

    expect(agentsOnBillingKey(providerAgents, 'a')).toEqual([])
    expect(
      agentsOnBillingCredential(
        providerAgents,
        [
          run({ credential_id: 'credential-a' }),
          run({ record_id: 'b', agent: 'b', credential_id: 'credential-a' }),
          run({ record_id: 'c', agent: 'c', credential_id: null }),
        ],
        'credential-a',
      ),
    ).toEqual(['a', 'b'])
  })

  test('a later successful probe paid by the credential clears its hold', () => {
    const providerAgents = [
      { name: 'a', provider: 'openrouter' },
      { name: 'b', provider: 'openrouter' },
    ]
    expect(
      decideBillingKeyHolds(providerAgents, [
        run({ credential_id: 'credential-a' }),
        run({
          record_id: 'b',
          number: 2,
          agent: 'b',
          credential_id: 'credential-a',
          failure_kind: null,
          status: 'ok',
          finished_at: 2,
        }),
      ]),
    ).toEqual([])
  })
})
