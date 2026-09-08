import { expect, test } from 'bun:test'
import { HarnessHealthSchema, OrchStateSchema } from './orch-contract.ts'

test('harness health has one validated cross-concern payload contract', () => {
  const payload = {
    header: 'never routing evidence', days: 1, from: '2026-09-07T00:00:00.000Z',
    classes: [{
      kind: 'timeout', count: 1, totalTimeMs: 1000, meanTimeMs: 1000,
      firstSeen: '2026-09-07T01:00:00.000Z', lastSeen: '2026-09-07T01:00:00.000Z',
      clusters: [{ text: 'timeout <n>', count: 1, exampleRunId: 7 }],
      sparkline: [{ day: '2026-09-07', count: 1 }],
    }],
    falseVerdicts: [{ kind: 'timeout', verdicts: 1, falseVerdicts: 0, rate: 0 }],
    landingRefusals: 0,
    mcpProbeFailures: 0,
    mcpUnprobed: 0,
    contention: { resources: [], sessions: [] },
  }
  expect(HarnessHealthSchema.parse(payload)).toEqual(payload)
  expect(() => HarnessHealthSchema.parse({ ...payload, landingRefusals: '0' })).toThrow()
})

test('orch state accepts a constructed cooling string and caps.contextTokens number or null', () => {
  const payload = {
    live: [],
    stale: 0,
    matrix: [],
    guide: [],
    health: [
      {
        agent: 'grok', billing: 'subscription', cooling: 'quota 51m ago',
        lastStatus: 'failed', lastKind: 'quota', minsAgo: 51,
      },
      {
        agent: 'codex', billing: 'subscription', cooling: null,
        lastStatus: 'ok', lastKind: null, minsAgo: 3,
      },
    ],
    totals: { runs: 0, failed: 0, stale_n: 0, toks: 0, scored: 0 },
    unscored: 0,
    spawns: [],
    agents: [
      {
        name: 'local-acp', billing: 'local',
        caps: {
          readsRepo: true, mcp: true, discoversMcpFromCwd: false, schema: false,
          writesRepo: false, resumable: false, contextTokens: 131072,
        },
      },
      {
        name: 'agy', billing: 'subscription',
        caps: {
          readsRepo: false, mcp: false, discoversMcpFromCwd: false, schema: true,
          writesRepo: false, resumable: false, contextTokens: null,
        },
      },
    ],
    byRepo: [],
  }
  const parsed = OrchStateSchema.parse(payload)
  expect(parsed.health[0]!.cooling).toBe('quota 51m ago')
  expect(parsed.health[1]!.cooling).toBeNull()
  expect(parsed.agents[0]!.caps.contextTokens).toBe(131072)
  expect(parsed.agents[1]!.caps.contextTokens).toBeNull()
})
