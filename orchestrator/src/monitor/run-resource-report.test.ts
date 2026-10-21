import { expect, test } from 'bun:test'
import { runResourceReport } from './run-resource-report.ts'

test('run resources report median and p90 by job, agent, and project', () => {
  const report = runResourceReport([
    { project: 'app', job: 'fix', agent: 'codex', cpuMs: 1_000, peakRssBytes: 100 },
    { project: 'app', job: 'fix', agent: 'codex', cpuMs: 2_000, peakRssBytes: 200 },
    { project: 'other', job: 'review', agent: 'claude', cpuMs: 3_000, peakRssBytes: 300 },
  ])
  expect(report.byJob).toEqual([
    {
      job: 'fix',
      runs: 2,
      cpuSeconds: { median: 1, p90: 2 },
      peakRssBytes: { median: 100, p90: 200 },
    },
    {
      job: 'review',
      runs: 1,
      cpuSeconds: { median: 3, p90: 3 },
      peakRssBytes: { median: 300, p90: 300 },
    },
  ])
  expect(report.byAgent[0]).toEqual({
    agent: 'claude',
    runs: 1,
    cpuSeconds: { median: 3, p90: 3 },
    peakRssBytes: { median: 300, p90: 300 },
  })
  expect(report.byProject[0]).toEqual({
    project: 'app',
    runs: 2,
    cpuSeconds: { median: 1, p90: 2 },
    peakRssBytes: { median: 100, p90: 200 },
  })
})
