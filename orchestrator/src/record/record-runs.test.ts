import { describe, expect, test } from 'bun:test'
import type { RecordRun } from './record-runs.ts'
import { recordRunsWindow, runRow } from './record-runs.ts'

const run = (id: string, overrides: Partial<RecordRun> = {}): RecordRun => ({
  id,
  number: Number(id),
  machine: {
    id: '01990000-0000-7000-8000-000000000099',
    shortName: 'starship',
    displayName: 'Starship',
  },
  machineLabel: `starship/${Number(id)}`,
  spaceId: '01990000-0000-7000-8000-000000000001',
  spaceName: 'One',
  projectName: 'project-a',
  startedAt: `2026-09-22T12:00:${id.padStart(2, '0')}.000Z`,
  finishedAt: '2026-09-22T12:01:00.000Z',
  agent: 'codex',
  job: 'implement',
  status: 'ok',
  latencyMs: 60_000,
  promptHead: 'ordinary prompt',
  taskKey: `DEV-${id}`,
  failureKind: null,
  vendorTokens: 100,
  modelCalls: 2,
  peakCallTokens: 60,
  quotaUsedPercentStart: null,
  quotaUsedPercentEnd: null,
  quotaWindowMinutes: null,
  quotaResetsAt: null,
  vendorCostUsd: 0.1,
  vendorInputTokens: 75,
  vendorOutputTokens: 25,
  vendorEstimatedCostUsd: null,
  vendorCostSource: 'billed',
  label: null,
  lens: null,
  parentRunId: null,
  turn: 1,
  evidenceExcluded: null,
  probe: false,
  score: null,
  ...overrides,
})

test('hosted run rows carry cross-machine labels with a safe unnamed-machine fallback', () => {
  const row = {
    id: '01990000-0000-7000-8000-000000000010',
    number: 42,
    machine_id: '01a0ab05-0000-7000-8000-000000000001',
    machine_short_name: 'starship',
    machine_display_name: 'Starship',
    space_id: '01990000-0000-7000-8000-000000000001',
    space_name: 'One',
    project_name: null,
    started_at: '2026-09-22T12:00:00.000Z',
    finished_at: null,
    agent: 'codex',
    job: 'implement',
    status: 'running',
    latency_ms: null,
    prompt_head: 'prompt',
    task_key: null,
    failure_kind: null,
    vendor_tokens: null,
    model_calls: null,
    peak_call_tokens: null,
    quota_used_percent_start: null,
    quota_used_percent_end: null,
    quota_window_minutes: null,
    quota_resets_at: null,
    vendor_cost_usd: null,
    vendor_input_tokens: null,
    vendor_output_tokens: null,
    vendor_estimated_cost_usd: null,
    vendor_cost_source: null,
    label: null,
    lens: null,
    parent_run_id: null,
    turn: 1,
    evidence_excluded: null,
    probe: false,
    delivery: null,
  }
  expect(runRow(row)).toMatchObject({ machineLabel: 'starship/42' })
  expect(runRow({ ...row, machine_short_name: null })).toMatchObject({
    machineLabel: '01a0ab05/42',
  })
})

describe('record run window', () => {
  test('filters before paging and reports the matched count', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      run(String(index), { agent: index < 5 ? 'codex' : 'grok' }),
    )
    const result = recordRunsWindow(rows, {
      agent: 'codex',
      project: '',
      search: '',
      offset: 0,
      limit: 25,
    })
    expect(result.matched).toBe(5)
    expect(result.items).toHaveLength(5)
    expect(result.items.every((item) => item.agent === 'codex')).toBe(true)
  })

  test('facets ignore filters and search', () => {
    const result = recordRunsWindow(
      [run('1'), run('2', { agent: 'grok', projectName: 'project-b', promptHead: 'needle' })],
      { agent: 'grok', project: 'project-b', search: 'needle', offset: 0, limit: 25 },
    )
    expect(result.facets).toEqual({
      agents: ['codex', 'grok'],
      projects: ['project-a', 'project-b'],
    })
    expect(result.matched).toBe(1)
  })

  test('counters count the whole window and list agents without token readings', () => {
    const result = recordRunsWindow(
      [run('1'), run('2', { agent: 'grok', vendorTokens: null, status: 'failed' })],
      { agent: 'codex', project: '', search: '', offset: 0, limit: 25 },
    )
    expect(result.totals.runs).toBe(2)
    expect(result.totals.failed).toBe(1)
    expect(result.vendors).toEqual([
      { agent: 'codex', tokens: 100, runs: 1 },
      { agent: 'grok', tokens: null, runs: 1 },
    ])
  })

  test('hosted totals do not count an unexcluded harness run as voided', () => {
    const result = recordRunsWindow([run('1', { agent: 'harness' })], {
      agent: '',
      project: '',
      search: '',
      offset: 0,
      limit: 25,
    })
    expect(result.totals).toMatchObject({ runs: 1, voided: 0 })
  })
})
