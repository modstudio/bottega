import { expect, test } from 'bun:test'
import { AGENTS } from '../agent/agent-registry.ts'
import { detachedRunOptions } from '../route/failover.ts'
import { assertSelectedAcpAllowed } from './run-acp-policy.ts'

const meteredAcpAgent = {
  ...AGENTS.codex!,
  name: 'metered-acp',
  billing: 'metered' as const,
  routeMetered: true,
  defaultTransport: 'acp' as const,
}

test('an automatically routed metered ACP review lens stays eligible at detached launch', () => {
  const opts = detachedRunOptions('review-lens', 'review it', 'reserved-id', {
    lens: 'correctness',
  })

  expect(() =>
    assertSelectedAcpAllowed(opts.job, meteredAcpAgent, opts.agentExplicit, true),
  ).not.toThrow()
})

test('porcelain presentation and distinct-model routing do not change detached ACP eligibility', () => {
  // --porcelain is deliberately absent from DetachSpec: it controls caller output only.
  const opts = detachedRunOptions('review-lens', 'review it', 'reserved-id', {
    lens: 'correctness',
    distinctModels: ['excluded-model'],
  })

  expect(opts.distinctModels).toEqual(['excluded-model'])
  expect(() =>
    assertSelectedAcpAllowed(opts.job, meteredAcpAgent, opts.agentExplicit, true),
  ).not.toThrow()
})
