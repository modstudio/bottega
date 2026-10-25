import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from './brand.ts'
import {
  HarnessHealthSchema,
  OrchAgentDefinitionSchema,
  OrchProjectSchema,
  OrchRunDetailSchema,
  OrchStateSchema,
} from './orch-contract.ts'

test('agent snapshot parsing preserves who operates the endpoint', () => {
  const parsed = OrchAgentDefinitionSchema.parse({
    name: 'local-acp',
    caps: { readsRepo: true },
    model: 'operator/model',
    operatedBy: 'self',
    contextTokens: 131_072,
    maxPromptBytes: null,
    timeoutMs: 60_000,
  })
  expect(parsed.operatedBy).toBe('self')
})

test('harness health has one validated cross-concern payload contract', () => {
  const payload = {
    header: 'never routing evidence',
    days: 1,
    from: '2026-09-07T00:00:00.000Z',
    classes: [
      {
        kind: 'timeout',
        count: 1,
        totalTimeMs: 1000,
        meanTimeMs: 1000,
        workPreserved: 0,
        firstSeen: '2026-09-07T01:00:00.000Z',
        lastSeen: '2026-09-07T01:00:00.000Z',
        clusters: [
          {
            text: 'timeout <n>',
            count: 1,
            exampleRunRecordId: '77777777-7777-4777-8777-777777777777',
            exampleRunNumber: 7,
          },
        ],
        sparkline: [{ day: '2026-09-07', count: 1 }],
      },
    ],
    falseVerdicts: [{ kind: 'timeout', verdicts: 1, falseVerdicts: 0, rate: 0 }],
    landingRefusals: 0,
    mcpProbeFailures: 0,
    mcpUnprobed: 0,
    contention: { resources: [], sessions: [] },
  }
  expect(HarnessHealthSchema.parse(payload)).toEqual(payload)
  expect(() => HarnessHealthSchema.parse({ ...payload, landingRefusals: '0' })).toThrow()
})

test(`${PLATFORM_SLUG} run state accepts a constructed cooling string and caps.contextTokens number or null`, () => {
  const payload = {
    live: [],
    stale: 0,
    matrix: [],
    guide: [],
    health: [
      {
        agent: 'grok',
        billing: 'subscription',
        cooling: 'quota 51m ago',
        lastStatus: 'failed',
        lastKind: 'quota',
        minsAgo: 51,
      },
      {
        agent: 'codex',
        billing: 'subscription',
        cooling: null,
        lastStatus: 'ok',
        lastKind: null,
        minsAgo: 3,
      },
    ],
    totals: { runs: 0, failed: 0, stale_n: 0, toks: 0, scored: 0 },
    unscored: 0,
    spawns: [],
    agents: [
      {
        name: 'local-acp',
        billing: 'none',
        caps: {
          readsRepo: true,
          mcp: true,
          discoversMcpFromCwd: false,
          schema: false,
          writesRepo: false,
          resumable: false,
          contextTokens: 131072,
        },
      },
      {
        name: 'agy',
        billing: 'subscription',
        caps: {
          readsRepo: false,
          mcp: false,
          discoversMcpFromCwd: false,
          schema: true,
          writesRepo: false,
          resumable: false,
          contextTokens: null,
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

test('run detail accepts a child-turn request with both run UUIDs', () => {
  const payload = {
    id: 12,
    record_id: '01990000-0000-7000-8000-000000000012',
    root_id: 10,
    root_record_id: '01990000-0000-7000-8000-000000000010',
    requested_id: 12,
    resolved_from: 'turn',
    agent: 'codex',
    job: 'implement',
    project: PLATFORM_NAME,
    latency_ms: 12,
    vendor_tokens: 34,
    status: 'ok',
    failure_kind: null,
    probe: false,
    evidence_excluded: null,
    error: null,
    prompt: 'spec',
    output: 'reply',
    delivery: 'full',
    quality: 'right',
    fidelity: 'faithful',
    note: null,
    scored_at: '2026-10-14T00:00:00.000Z',
    scoreAxes: ['delivery', 'quality', 'fidelity'],
    reviews: [],
  }
  expect(OrchRunDetailSchema.parse(payload)).toMatchObject({
    id: 12,
    record_id: payload.record_id,
    root_id: 10,
    root_record_id: payload.root_record_id,
  })
})

/** The `project list --json` row shape, with a tracker a newer binary extended. */
const listedProjectRow = {
  name: PLATFORM_NAME,
  path: '/w/probe',
  stack: null,
  canon: true,
  settings: {
    tracker: {
      protocol: 'cursor-mcp',
      actions: { search: 'task_list', newVerb: 'tool' },
      reviewStages: { waiting: 'waiting-review', active: 'in-review', brandNew: 'x' },
    },
  },
  visibility: null,
  record_id: '01990000-0000-7000-8000-000000000021',
  repository: true,
  lifecycle_form: 'managed',
  problems: [],
  commit_hooks_skipped: true,
  gate: null,
}

test('the published register accepts a tracker action and stage this binary does not know', () => {
  const parsed = OrchProjectSchema.parse(listedProjectRow)
  expect(parsed.settings.tracker).toMatchObject({
    protocol: 'cursor-mcp',
    actions: { search: 'task_list' },
    reviewStages: { waiting: 'waiting-review', active: 'in-review' },
  })
})

test('the published register still judges the tracker keys it knows', () => {
  expect(() =>
    OrchProjectSchema.parse({
      ...listedProjectRow,
      settings: { tracker: { protocol: 'hub', actions: { search: 'task_list' } } },
    }),
  ).toThrow('the built-in tracker accepts no action overrides; remove tracker.actions')
  expect(() =>
    OrchProjectSchema.parse({
      ...listedProjectRow,
      settings: {
        tracker: { protocol: 'hub', projectId: '01990000-0000-7000-8000-000000000022' },
      },
    }),
  ).toThrow('projectId is accepted only by the cursor-mcp protocol')
})
