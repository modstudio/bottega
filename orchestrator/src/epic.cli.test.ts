import { describe, expect, test } from 'bun:test'
import { addRun, db } from '../test/fixture.ts'
import { epicScoreboard, renderEpicHuman } from './epic.ts'

describe('epic scoreboard', () => {
  test('computes every recorded metric once for human and JSON views', () => {
    const first = addRun({ agent: 'codex', job: 'implement', status: 'failed', latency: 120_000, startedAt: '2026-09-08T10:00:00.000Z' })
    db().query(`UPDATE run SET launch_key='DEV-501',branch='DEV-501-orch-1',vendor_tokens=NULL,
      vendor_cost_usd=NULL,last_event_at='2026-09-08T10:01:00.000Z' WHERE id=?`).run(first)
    const continued = addRun({ agent: 'codex', job: 'implement', status: 'ok', latency: 60_000, parent: first, turn: 2, startedAt: '2026-09-08T10:03:00.000Z' })
    db().query(`UPDATE run SET launch_key=NULL,branch='repair/DEV-501-drift',vendor_tokens=1200,
      vendor_cost_usd=0,last_event_at='2026-09-08T10:03:30.000Z' WHERE id=?`).run(continued)
    const lens = addRun({ agent: 'grok', job: 'review-lens', status: 'ok', latency: 30_000, startedAt: '2026-09-08T10:05:00.000Z' })
    db().query(`UPDATE run SET launch_key='DEV-501',branch='DEV-501-orch-1',vendor_tokens=500,
      vendor_cost_usd=0.25,last_event_at='2026-09-08T10:05:20.000Z' WHERE id=?`).run(lens)
    db().query(`INSERT INTO review (recorded_at,completed_at,outdated_at,outdated_reason)
      VALUES ('2026-09-08T10:06:00.000Z','2026-09-08T10:07:00.000Z','2026-09-08T10:08:00.000Z','changed')`).run()
    const reviewId = Number((db().query('SELECT last_insert_rowid() id').get() as { id: number }).id)
    db().query(`INSERT INTO review_lens
      (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
      VALUES (?,?,'correctness','grok','[]','[]','[]','[]')`).run(reviewId, lens)
    db().query(`INSERT INTO landing
      (project,branch,status,error,started_at,finished_at,steps)
      VALUES ('fixture','DEV-501-orch-1','refused','gate failed\nfull detail','2026-09-08T10:09:00Z','2026-09-08T10:10:00Z','[]')`).run()
    db().query(`INSERT INTO landing
      (project,branch,status,started_at,finished_at,steps)
      VALUES ('fixture','DEV-501-orch-1','landed','2026-09-08T10:11:00Z','2026-09-08T10:12:00Z',?)`)
      .run(JSON.stringify([{ name: '_flags', unreviewed: 'tier 0', strandLive: 'operator accepted' }]))

    const report = epicScoreboard('DEV-500', [
      { key: 'DEV-501', title: 'worked' }, { key: 'DEV-502', title: 'empty' },
    ], db())
    expect(report.children[0]).toMatchObject({
      runs: { total: 3, byJob: { implement: 2, 'review-lens': 1 } },
      wallTimeMs: 210_000, elapsedSpanMs: 330_000,
      vendorTokens: 1700, vendorCostUsd: 0.25,
      unreportedUsageRuns: { tokens: 1, cost: 1 }, lensRounds: 1, fixRounds: 0,
      landings: { attempted: 2, landed: 1, refused: 1, refusedByCause: { 'gate failed': 1 } },
      reviews: { recorded: 1, completed: 1, outdated: 1 }, strandings: { count: 1 }, idleMinutes: 2,
      continuations: { count: 1, branchDrift: 1 }, architectCommits: null,
    })
    expect(report.children[0]!.strandings.reasons).toEqual([
      { landingId: expect.any(Number), kind: 'strand-live', reason: 'operator accepted' },
      { landingId: expect.any(Number), kind: 'unreviewed', reason: 'tier 0' },
    ])
    expect(report.children[1]).toMatchObject({ runs: { total: 0, byJob: {} }, vendorTokens: null, vendorCostUsd: null, landings: { attempted: 0 }, reviews: { recorded: 0 } })
    expect(report.notRecorded).toEqual([{
      metric: 'architect commits on run branches',
      needed: 'record commit author role and task/run attribution when an architect commits on a run branch',
    }])
    expect(report.total).toMatchObject({ runs: { total: 3 }, landings: { attempted: 2, landed: 1, refused: 1 }, reviews: { recorded: 1, completed: 1, outdated: 1 } })

    const human = renderEpicHuman(report)
    const json = JSON.parse(JSON.stringify(report))
    expect(human).toContain('DEV-501')
    expect(human).toContain('implement=2,review-lens=1')
    expect(human).toContain('1x gate failed')
    expect(human).toContain('NOT RECORDED')
    expect(json).toEqual(report)
  })

  test('an epic with no children is an empty scoreboard', () => {
    const report = epicScoreboard('DEV-EMPTY', [], db())
    expect(report.children).toEqual([])
    expect(report.total).toMatchObject({ runs: { total: 0, byJob: {} }, vendorTokens: null })
    expect(renderEpicHuman(report)).toContain('TOTAL')
  })
})
