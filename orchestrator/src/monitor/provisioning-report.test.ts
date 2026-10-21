import { describe, expect, test } from 'bun:test'
import {
  type ProvisioningObservation,
  provisioningReport,
  runResourceReport,
} from './provisioning-report.ts'

const sample = (durationMs: number, entries = durationMs): ProvisioningObservation => ({
  project: 'app',
  kind: 'writer',
  outcome: 'ok',
  durationMs,
  entries,
  entriesLimited: false,
  hostLoad: {
    gates: 0,
    loadavg: durationMs,
    ncpu: 8,
    freeMem: 1,
    pressure: 'normal',
    swapUsed: 2,
    swapTotal: 3,
    recentAdmissions: 0,
    waitingRequests: 0,
    oldestWaitMs: 0,
    liveRuns: 1,
  },
})

test('run resources report median and p90 by job and project', () => {
  const report = runResourceReport([
    { project: 'app', job: 'fix', cpuMs: 1_000, peakRssBytes: 100 },
    { project: 'app', job: 'fix', cpuMs: 2_000, peakRssBytes: 200 },
    { project: 'other', job: 'review', cpuMs: 3_000, peakRssBytes: 300 },
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
  expect(report.byProject[0]).toEqual({
    project: 'app',
    runs: 2,
    cpuSeconds: { median: 1, p90: 2 },
    peakRssBytes: { median: 100, p90: 200 },
  })
})

describe('provisioning report policy', () => {
  test('reports nearest-rank median and p90 and marks a small sample', () => {
    const report = provisioningReport([sample(1), sample(2), sample(3), sample(4)])
    expect(report[0]?.provisioningMs).toEqual({ median: 2, p90: 4 })
    expect(report[0]?.comparison).toBe('sample too small to compare (4/5 runs)')
    expect(report[0]?.hostLoad.oneMinute).toEqual({ min: 1, max: 4 })
  })
  test('does not present bounded entry counts as exact percentiles', () => {
    const rows = [sample(1, 10), { ...sample(2, 100_000), entriesLimited: true }]
    expect(provisioningReport(rows)[0]?.entries).toEqual({
      median: 10,
      p90: 10,
      limitedRuns: 1,
      unavailableRuns: 0,
    })
  })
  test('keeps failed provisioning in the report', () => {
    const report = provisioningReport([{ ...sample(1), outcome: 'failed' }])
    expect(report[0]?.outcomes).toEqual({ ok: 0, failed: 1 })
  })
})
