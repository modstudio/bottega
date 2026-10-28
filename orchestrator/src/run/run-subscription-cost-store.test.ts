import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { SUBSCRIPTION_QUOTA_SHARE_SOURCE, withReportedCost } from './run-subscription-cost.ts'
import { subscriptionCostFacts } from './run-subscription-cost-store.ts'

test('aggregates one harness quota window and uses it for reported cost', () => {
  const resetsAt = 1_800_000_001
  const first = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: '2026-10-28T12:00:00.000Z',
  })
  const second = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: '2026-10-28T13:00:00.000Z',
  })
  const otherHarness = addRun({
    agent: 'grok',
    job: 'understand',
    startedAt: '2026-10-28T14:00:00.000Z',
  })
  const update = db().query(
    `UPDATE run SET vendor_tokens=?, quota_used_percent_start=?, quota_used_percent_end=?,
                    quota_window_minutes=10080, quota_resets_at=? WHERE record_id=?`,
  )
  update.run(100, 12, 13, resetsAt, first)
  update.run(300, 13, 16, resetsAt, second)
  update.run(900, 1, 50, resetsAt, otherHarness)

  const facts = subscriptionCostFacts()
  expect(facts.quotaWindows?.find((window) => window.harness === 'codex')).toEqual({
    harness: 'codex',
    resetsAt,
    windowMinutes: 10_080,
    usedPercentStart: 12,
    usedPercentEnd: 16,
    tokens: 400,
  })

  const priced = withReportedCost(
    {
      agent: 'codex',
      started_at: '2026-10-28T12:00:00.000Z',
      vendor_tokens: 100,
      vendor_cost_usd: null,
      vendor_estimated_cost_usd: null,
      vendor_cost_source: 'subscription',
      quota_resets_at: resetsAt,
    },
    { facts, prices: { codex: 200 } },
  )
  expect(priced.cost_source).toBe(SUBSCRIPTION_QUOTA_SHARE_SOURCE)
  expect(priced.cost_usd).toBeCloseTo((200 * 10_080 * 0.04 * 100) / (43_830 * 400))
})
