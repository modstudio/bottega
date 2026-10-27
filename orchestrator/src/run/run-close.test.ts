import { expect, test } from 'bun:test'
import { AGENTS } from '../agent/agent-registry.ts'
import { failoverSelectionConstraints, selectFailoverSuccessor } from './run-close.ts'

test('failover pins only an explicit transport and excludes agents that cannot honor it', () => {
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 1,
      avoided: ['avoided', 'tried'],
      distinctModels: undefined,
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
    }),
  ).toEqual({
    pinnedTransport: 'acp',
    successorTransport: 'acp',
    avoidedAgents: ['avoided', 'tried', 'wrong-transport'],
    distinctModels: undefined,
  })
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 0,
      avoided: ['avoided'],
      distinctModels: undefined,
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
    }),
  ).toEqual({
    pinnedTransport: null,
    successorTransport: undefined,
    avoidedAgents: ['avoided', 'tried'],
    distinctModels: undefined,
  })
})

test('failover successor selection honors distinct model exclusions', async () => {
  const selected = await selectFailoverSuccessor({
    runId: 'unused-without-capacity-wait',
    job: 'review-lens',
    pickBytes: 0,
    lens: null,
    launchCwd: null,
    callerCwd: process.cwd(),
    repo: null,
    mcp: null,
    mcpError: null,
    pinnedTransport: null,
    avoidedAgents: [],
    distinctModels: [AGENTS.grok!.model],
  })

  expect(selected.agent).toBe('codex')
})
