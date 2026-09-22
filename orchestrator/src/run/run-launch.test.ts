import { describe, expect, test } from 'bun:test'
import { decideRunLaunch, type RunLaunchFacts } from './run-launch.ts'

const baseFacts: RunLaunchFacts = {
  resume: null,
  pickedAgent: 'picked',
  pickedReason: 'routing evidence',
  requestedTransport: 'acp',
  explicitTransport: false,
  envTransport: false,
  agentDefaultTransport: 'cli',
}

describe('run launch ruling', () => {
  test.each([
    {
      name: 'resume wins over any pick and keeps the requested transport',
      facts: {
        ...baseFacts,
        resume: { parent: 41, turn: 3, agent: 'resumed' },
      },
      expected: {
        agent: 'resumed',
        reason:
          'resumed run 41 (turn 3); repository path retargeting not applied because the turn is already bound to its worktree',
        transport: 'acp',
      },
    },
    {
      name: 'no resume uses the pick and the agent default transport',
      facts: baseFacts,
      expected: { agent: 'picked', reason: 'routing evidence', transport: 'cli' },
    },
    {
      name: 'an explicit transport keeps the requested transport',
      facts: { ...baseFacts, explicitTransport: true },
      expected: { agent: 'picked', reason: 'routing evidence', transport: 'acp' },
    },
    {
      name: 'an environment override keeps the requested transport',
      facts: { ...baseFacts, envTransport: true },
      expected: { agent: 'picked', reason: 'routing evidence', transport: 'acp' },
    },
  ])('$name', ({ facts, expected }) => {
    expect(decideRunLaunch(facts)).toEqual(expected)
  })
})
