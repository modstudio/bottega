import { describe, expect, spyOn, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { epicChildren, epicScoreboard } from './epic.ts'
import { reapStale } from './run-liveness.ts'

const intervalOrigin = Date.parse('2026-09-08T10:00:00.000Z')
function timedRun(key: string, startOffsetMs: number, latency: number): number {
  const run = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    latency,
    startedAt: new Date(intervalOrigin + startOffsetMs).toISOString(),
  })
  db().query('UPDATE run SET launch_key=? WHERE id=?').run(key, run)
  return run
}
const intervalScore = (...keys: string[]) =>
  epicScoreboard(
    'DEV-INTERVALS',
    keys.map((key) => ({ key })),
    db(),
    intervalOrigin + 3_600_000,
  )

describe('epic scoreboard', () => {
  test('computes every recorded metric once for human and JSON views', () => {
    // Offset-less SQLite ISO text is UTC, not the machine's local timezone.
    const first = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      latency: 120_000,
      startedAt: '2026-09-08T10:00:00.000',
    })
    db()
      .query(`UPDATE run SET launch_key='DEV-501',branch='DEV-501-orch-1',vendor_tokens=NULL,
      vendor_cost_usd=NULL,last_event_at='2026-09-08T10:01:00.000Z' WHERE id=?`)
      .run(first)
    const continued = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      latency: 60_000,
      parent: first,
      turn: 2,
      startedAt: '2026-09-08T10:01:00.000Z',
    })
    db()
      .query(`UPDATE run SET launch_key=NULL,branch='repair/DEV-501-drift',vendor_tokens=1200,
      vendor_cost_usd=0,last_event_at='2026-09-08T10:01:30.000Z' WHERE id=?`)
      .run(continued)
    const lens = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'ok',
      latency: 30_000,
      startedAt: '2026-09-08T10:05:00.000Z',
    })
    db()
      .query(`UPDATE run SET launch_key='DEV-501',branch='DEV-501-orch-1',vendor_tokens=500,
      vendor_cost_usd=0.25,last_event_at='2026-09-08T10:05:20.000Z' WHERE id=?`)
      .run(lens)
    const ghost = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'running',
      startedAt: '2026-09-08T08:00:00.000Z',
    })
    db()
      .query(`UPDATE run SET launch_key='DEV-501',branch='DEV-501-orch-1',latency_ms=NULL,
      last_event_at='2026-09-08T08:30:00.000Z' WHERE id=?`)
      .run(ghost)
    db()
      .query(`INSERT INTO review (recorded_at,completed_at,outdated_at,outdated_reason)
      VALUES ('2026-09-08T10:06:00.000Z','2026-09-08T10:07:00.000Z','2026-09-08T10:08:00.000Z','changed')`)
      .run()
    const reviewId = Number(
      (db().query('SELECT last_insert_rowid() id').get() as { id: number }).id,
    )
    db()
      .query(`INSERT INTO review_lens
      (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
      VALUES (?,?,'correctness','grok','[]','[]','[]','[]')`)
      .run(reviewId, lens)
    db()
      .query(`INSERT INTO landing
      (project,branch,status,error,started_at,finished_at,steps)
      VALUES ('fixture','DEV-501-orch-1','refused','gate failed\nfull detail','2026-09-08T10:09:00Z','2026-09-08T10:10:00Z','[]')`)
      .run()
    db()
      .query(`INSERT INTO landing
      (project,branch,status,started_at,finished_at,steps)
      VALUES ('fixture','DEV-501-orch-1','landed','2026-09-08T10:11:00Z','2026-09-08T10:12:00Z',?)`)
      .run(
        JSON.stringify([{ name: '_flags', unreviewed: 'tier 0', strandLive: 'operator accepted' }]),
      )

    const report = epicScoreboard(
      'DEV-500',
      [
        { key: 'DEV-501', title: 'worked' },
        { key: 'DEV-502', title: 'empty' },
      ],
      db(),
      Date.parse('2026-09-08T12:00:00.000Z'),
    )
    expect(report.children[0]).toMatchObject({
      runs: { total: 4, byJob: { implement: 3, 'review-lens': 1 } },
      agentTimeMs: 210_000,
      occupancyMs: 150_000,
      elapsedSpanMs: 330_000,
      runDurationMeanMs: 70_000,
      runDurationP95Ms: 120_000,
      ghostRuns: 1,
      vendorTokens: 1700,
      vendorCostUsd: 0.25,
      unreportedUsageRuns: { tokens: 2, cost: 2 },
      lensRounds: 1,
      fixRounds: 0,
      landings: { attempted: 2, landed: 1, refused: 1, refusedByCause: { 'gate failed': 1 } },
      reviews: { recorded: 1, completed: 1, outdated: 1 },
      strandings: { count: 1 },
      idleMinutes: 2,
      continuations: { count: 1, branchDrift: 1 },
      architectCommits: null,
    })
    expect(report.children[0]!.strandings.reasons).toEqual([
      { landingId: expect.any(Number), kind: 'strand-live', reason: 'operator accepted' },
      { landingId: expect.any(Number), kind: 'unreviewed', reason: 'tier 0' },
    ])
    expect(report.children[1]).toMatchObject({
      runs: { total: 0, byJob: {} },
      vendorTokens: null,
      vendorCostUsd: null,
      landings: { attempted: 0 },
      reviews: { recorded: 0 },
    })
    expect(report.notRecorded).toEqual([
      {
        metric: 'architect commits on run branches',
        needed:
          'record commit author role and task/run attribution when an architect commits on a run branch',
      },
    ])
    expect(report.total).toMatchObject({
      runs: { total: 4 },
      agentTimeMs: 210_000,
      occupancyMs: 150_000,
      elapsedSpanMs: 330_000,
      runDurationMeanMs: 70_000,
      runDurationP95Ms: 120_000,
      ghostRuns: 1,
      landings: { attempted: 2, landed: 1, refused: 1 },
      reviews: { recorded: 1, completed: 1, outdated: 1 },
    })
    expect(reapStale(db())).toBe(1)
    expect(
      db().query('SELECT status,failure_kind,latency_ms FROM run WHERE id=?').get(ghost),
    ).toEqual({
      status: 'stale',
      failure_kind: 'interrupted',
      latency_ms: null,
    })
    const afterReap = epicScoreboard(
      'DEV-500',
      [
        { key: 'DEV-501', title: 'worked' },
        { key: 'DEV-502', title: 'empty' },
      ],
      db(),
      Date.parse('2026-09-08T12:00:00.000Z'),
    )
    expect(afterReap.children[0]!.ghostRuns).toBe(1)
    expect(afterReap.total.ghostRuns).toBe(1)
    expect(afterReap.total).toMatchObject({
      agentTimeMs: 210_000,
      occupancyMs: 150_000,
      elapsedSpanMs: 330_000,
    })
  })

  test('an epic with no children is an empty scoreboard', () => {
    const report = epicScoreboard('DEV-EMPTY', [], db())
    expect(report.children).toEqual([])
    expect(report.total).toMatchObject({ runs: { total: 0, byJob: {} }, vendorTokens: null })
  })

  test('total occupancy unions overlapping children instead of adding child occupancy', () => {
    timedRun('DEV-A', 0, 120_000)
    timedRun('DEV-B', 60_000, 120_000)
    const report = intervalScore('DEV-A', 'DEV-B')
    expect(report.children.map((row) => row.occupancyMs)).toEqual([120_000, 120_000])
    expect(report.total.occupancyMs).toBe(180_000)
    expect(report.total.occupancyMs).not.toBe(240_000)
  })

  test('shared-start runs union within one child', () => {
    timedRun('DEV-SHARED', 0, 60_000)
    timedRun('DEV-SHARED', 0, 120_000)
    expect(intervalScore('DEV-SHARED').children[0]).toMatchObject({
      agentTimeMs: 180_000,
      occupancyMs: 120_000,
      elapsedSpanMs: 120_000,
    })
  })

  test('touching runs occupy their full span', () => {
    timedRun('DEV-TOUCH', 0, 120_000)
    timedRun('DEV-TOUCH', 120_000, 120_000)
    // Equal sums cannot discriminate whether the zero-width seam was merged.
    expect(intervalScore('DEV-TOUCH').children[0]).toMatchObject({
      agentTimeMs: 240_000,
      occupancyMs: 240_000,
      elapsedSpanMs: 240_000,
    })
  })

  test('zero-length runs affect span but not occupancy', () => {
    timedRun('DEV-ZERO-PLUS', 0, 0)
    timedRun('DEV-ZERO-PLUS', 60_000, 60_000)
    timedRun('DEV-ZERO-ALONE', 0, 0)
    const report = intervalScore('DEV-ZERO-PLUS', 'DEV-ZERO-ALONE')
    expect(report.children[0]).toMatchObject({ occupancyMs: 60_000, elapsedSpanMs: 120_000 })
    expect(report.children[1]).toMatchObject({ occupancyMs: 0, elapsedSpanMs: 0 })
  })

  test('a single timed run has identical agent, occupancy, and span durations', () => {
    timedRun('DEV-SINGLE', 0, 90_000)
    expect(intervalScore('DEV-SINGLE').children[0]).toMatchObject({
      agentTimeMs: 90_000,
      occupancyMs: 90_000,
      elapsedSpanMs: 90_000,
    })
  })

  test('occupancy and span are independent of insertion order', () => {
    timedRun('DEV-REVERSE', 300_000, 60_000)
    timedRun('DEV-REVERSE', 0, 120_000)
    expect(intervalScore('DEV-REVERSE').children[0]).toMatchObject({
      agentTimeMs: 180_000,
      occupancyMs: 180_000,
      elapsedSpanMs: 360_000,
    })
  })

  test('negative latency uses one clamped run end for occupancy and idle', () => {
    const run = timedRun('DEV-NEGATIVE', 0, -60_000)
    db()
      .query('UPDATE run SET last_event_at=? WHERE id=?')
      .run(new Date(intervalOrigin - 60_000).toISOString(), run)
    expect(intervalScore('DEV-NEGATIVE').children[0]).toMatchObject({
      agentTimeMs: 0,
      occupancyMs: 0,
      elapsedSpanMs: 0,
      runDurationMeanMs: 0,
      runDurationP95Ms: 0,
      idleMinutes: 1,
    })
  })

  test('computes offset-less SQLite idle timestamps as UTC outside a UTC process', () => {
    const run = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      latency: 120_000,
      startedAt: '2026-09-08T10:00:00.000',
    })
    db()
      .query(
        `UPDATE run SET launch_key='DEV-TZ',last_event_at='2026-09-08T10:01:00.000Z' WHERE id=?`,
      )
      .run(run)
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const report = epicScoreboard('DEV-TZ-PARENT', [{ key: 'DEV-TZ' }], db())
      expect(report.children[0]!.idleMinutes).toBe(1)
      expect(report.total.idleMinutes).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  test('shells out to hub for child membership and CLI views use that result', async () => {
    const children = [
      { key: 'DEV-501', title: 'child one' },
      { key: 'DEV-502', title: 'child two' },
    ]
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => ({
      stdout: JSON.stringify(children),
      stderr: '',
      exited: Promise.resolve(0),
      args,
    })) as unknown as ReturnType<typeof Bun.spawn>)
    try {
      expect(await epicChildren('DEV-500')).toEqual(children)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn.mock.calls[0]![0]).toEqual(
        expect.arrayContaining(['task', 'list', '--parent', 'DEV-500', '--json']),
      )
    } finally {
      spawn.mockRestore()
    }
  })
})
