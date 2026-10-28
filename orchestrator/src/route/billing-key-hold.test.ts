import { describe, expect, test } from 'bun:test'
import { type BillingKeyRun, decideBillingKeyHolds } from './billing-key-hold.ts'

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
  finished_at: 1,
  ...overrides,
})

describe('billing key holds', () => {
  test('billing on one agent holds its sibling but not another key', () => {
    expect(decideBillingKeyHolds(agents, [run({})])).toEqual([
      {
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
})
