import { expect, test } from 'bun:test'
import { AGENTS } from '../agent/agent-registry.ts'
import { detachedRunOptions } from '../route/failover.ts'
import { assertAcpPolicyAllowed, assertSelectedAcpAllowed } from './run-acp-policy.ts'

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

  expect(() => {
    assertAcpPolicyAllowed(opts.job, meteredAcpAgent.name, meteredAcpAgent, false)
    assertSelectedAcpAllowed(opts.job, meteredAcpAgent, opts.agentExplicit, true)
  }).not.toThrow()
})

test('an ACP review lens without metered routing opt-in still requires a named agent', () => {
  const opts = detachedRunOptions('review-lens', 'review it', 'reserved-id', {
    lens: 'correctness',
  })
  const unoptedAgent = { ...meteredAcpAgent, routeMetered: false }

  expect(() => assertSelectedAcpAllowed(opts.job, unoptedAgent, opts.agentExplicit, true)).toThrow(
    'require an agent named with --agent',
  )
})
