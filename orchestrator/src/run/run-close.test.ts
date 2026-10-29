import { afterEach, beforeEach, expect, test } from 'bun:test'
import { addRun, seedNeutralCodexQuotaReading } from '../../test/fixtures/store.ts'
import { AGENTS, refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { failoverSelectionConstraints, selectFailoverSuccessor } from './run-close.ts'

afterEach(refreshAgents)
beforeEach(() => seedNeutralCodexQuotaReading())

test('failover pins only an explicit transport and excludes agents that cannot honor it', () => {
  expect(
    failoverSelectionConstraints({
      transport: 'acp',
      transportExplicit: 1,
      avoided: ['avoided', 'tried'],
      distinctModels: undefined,
      tried: ['tried'],
      transportExcluded: ['wrong-transport'],
      billingExcluded: [],
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
      billingExcluded: [],
    }),
  ).toEqual({
    pinnedTransport: null,
    successorTransport: undefined,
    avoidedAgents: ['avoided', 'tried'],
    distinctModels: undefined,
  })
})

test('failover selection reads a billing hold and does not select its sibling', async () => {
  db()
    .query(
      "UPDATE agent SET base_url='https://shared.test',api_key_secret='SHARED_KEY' WHERE name IN ('codex','grok')",
    )
    .run()
  refreshAgents()
  addRun({ agent: 'codex', job: 'review-lens', status: 'failed', kind: 'billing' })

  await expect(
    selectFailoverSuccessor({
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
      avoidedAgents: ['codex'],
      distinctModels: undefined,
    }),
  ).rejects.toThrow('billing key SHARED_KEY is held')
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
