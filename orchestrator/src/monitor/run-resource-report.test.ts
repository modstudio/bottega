import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { loadRunResourceReport, runResourceReport } from './run-resource-report.ts'

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

test('stored resource report skips runs with null measurements', () => {
  const database = new Database(':memory:')
  database.exec(
    `CREATE TABLE project(record_id TEXT PRIMARY KEY,name TEXT NOT NULL);
     CREATE TABLE run(project_record_id TEXT,job TEXT NOT NULL,agent TEXT NOT NULL,
       resource_cpu_ms INTEGER,resource_peak_rss_bytes INTEGER,started_at TEXT NOT NULL);
     INSERT INTO project VALUES ('p','app');
     INSERT INTO run VALUES ('p','fix','codex',NULL,NULL,'2026-10-21T00:00:00Z');
     INSERT INTO run VALUES ('p','fix','codex',1000,100,'2026-10-21T00:00:01Z');`,
  )
  const report = loadRunResourceReport(database, { sinceMs: null })
  expect(report.byJob).toHaveLength(1)
  expect(report.byJob[0]?.runs).toBe(1)
})
