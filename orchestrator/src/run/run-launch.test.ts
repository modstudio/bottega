import { describe, expect, test } from 'bun:test'
import { decideRunLaunch, type RunLaunchFacts } from './run-launch.ts'

const baseFacts: RunLaunchFacts = {
  source: 'pick',
  agent: 'picked',
  reason: 'routing evidence',
  explicitTransport: false,
  envTransport: false,
}

describe('run launch ruling', () => {
  test.each([
    {
      name: 'resume wins over any pick and keeps the requested transport',
      facts: {
        source: 'resume' as const,
        parent: 41,
        turn: 3,
        agent: 'resumed',
        explicitTransport: false,
        envTransport: false,
      },
      expected: {
        agent: 'resumed',
        reason:
          'resumed run 41 (turn 3); repository path retargeting not applied because the turn is already bound to its worktree',
        useRequestedTransport: true,
      },
    },
    {
      name: 'no resume uses the pick and the agent default transport',
      facts: baseFacts,
      expected: { agent: 'picked', reason: 'routing evidence', useRequestedTransport: false },
    },
    {
      name: 'an explicit transport keeps the requested transport',
      facts: { ...baseFacts, explicitTransport: true },
      expected: { agent: 'picked', reason: 'routing evidence', useRequestedTransport: true },
    },
    {
      name: 'an environment override keeps the requested transport',
      facts: { ...baseFacts, envTransport: true },
      expected: { agent: 'picked', reason: 'routing evidence', useRequestedTransport: true },
    },
  ])('$name', ({ facts, expected }) => {
    expect(decideRunLaunch(facts)).toEqual(expected)
  })
})
