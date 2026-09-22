import { describe, expect, test } from 'bun:test'
import type { RecordRun } from './record-runs.ts'
import { recordRunsWindow } from './record-runs.ts'

const run = (id: string, overrides: Partial<RecordRun> = {}): RecordRun => ({
  id,
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
  vendorCostUsd: 0.1,
  label: null,
  lens: null,
  parentRunId: null,
  turn: 1,
  evidenceExcluded: null,
  probe: false,
  score: null,
  ...overrides,
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
})
