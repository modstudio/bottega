import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { refreshAgents } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import type { SubscriptionCostContext } from '../run/run-subscription-cost.ts'
import { gatherRouteCostBacktestSnapshots } from './route-cost-backtest-adapter.ts'

const agent = 'codex'
const costContext: SubscriptionCostContext = {
  facts: {
    agents: { [agent]: { billing: 'metered', harness: 'opencode' } },
    monthTokens: {},
  },
  prices: {},
}

function scoreAt(runId: string, scoredAt: string): void {
  db()
    .query(
      `INSERT INTO score (record_id,run_record_id,delivery,quality,scored_at,scored_by)
       VALUES (?,?,'full','right',?,'test')`,
    )
    .run(newRecordId(), runId, scoredAt)
}

function price(runId: string, usd: number): void {
  db()
    .query(
      `UPDATE run SET vendor_cost_usd=?,vendor_cost_source='vendor',vendor_tokens=100
        WHERE record_id=?`,
    )
    .run(usd, runId)
}

function optInMeteredAgent(): void {
  db().query("UPDATE agent SET billing='metered',route_metered=1 WHERE name=?").run(agent)
  refreshAgents()
}

test('snapshot excludes a later judgment and a chain-turn cost unavailable at dispatch', () => {
  optInMeteredAgent()
  const prior = addRun({
    agent,
    job: 'summarize',
    startedAt: '2026-01-01T00:00:00.000Z',
    latency: 1_000,
  })
  scoreAt(prior, '2026-01-01T00:00:02.000Z')
  price(prior, 0.2)

  const laterJudgment = addRun({
    agent,
    job: 'summarize',
    startedAt: '2026-01-02T00:00:00.000Z',
    latency: 1_000,
  })
  scoreAt(laterJudgment, '2026-01-10T00:00:02.000Z')
  price(laterJudgment, 0.3)

  addRun({
    agent,
    job: 'summarize',
    parent: prior,
    turn: 2,
    startedAt: '2026-01-10T00:00:01.000Z',
    latency: 1_000,
  })
  const lateTurn = db()
    .query('SELECT record_id FROM run WHERE parent_run_record_id=?')
    .get(prior) as { record_id: string }
  price(lateTurn.record_id, 0.5)

  addRun({
    agent,
    job: 'summarize',
    startedAt: '2026-01-10T00:00:00.000Z',
    latency: 1_000,
  })

  const snapshot = gatherRouteCostBacktestSnapshots(
    1,
    costContext,
    new Date('2026-01-10T12:00:00.000Z'),
  )
  expect(snapshot.decisions).toHaveLength(1)
  const candidate = snapshot.decisions[0]!.candidates.find((row) => row.agent === agent)!
  expect(candidate.evidence).toBe(1)
  expect(candidate.meanCostPerRun).toEqual({ usd: 0.2 })
})

test('a thin correctness lens falls back to job evidence but keeps the high-stakes policy tier', () => {
  optInMeteredAgent()
  const prior = addRun({
    agent,
    job: 'review-lens',
    startedAt: '2026-01-01T00:00:00.000Z',
    latency: 1_000,
  })
  scoreAt(prior, '2026-01-01T00:00:02.000Z')
  const decision = addRun({
    agent,
    job: 'review-lens',
    startedAt: '2026-01-10T00:00:00.000Z',
    latency: 1_000,
  })
  const reviewId = newRecordId()
  db()
    .query(
      `INSERT INTO review(record_id,number,recorded_at,role)
       VALUES (?,1,'2026-01-10T00:00:00.000Z','round')`,
    )
    .run(reviewId)
  db()
    .query(
      `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,'correctness',?,'[]','[]','[]','[]')`,
    )
    .run(newRecordId(), reviewId, decision, agent)

  const snapshot = gatherRouteCostBacktestSnapshots(
    1,
    costContext,
    new Date('2026-01-10T12:00:00.000Z'),
  )
  expect(snapshot.decisions).toHaveLength(1)
  expect(snapshot.decisions[0]).toMatchObject({ lens: 'correctness', group: 'high-stakes' })
})
