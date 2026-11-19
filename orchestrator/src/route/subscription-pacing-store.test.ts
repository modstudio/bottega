import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { decideSubscriptionPacing } from './subscription-pacing.ts'
import {
  SUBSCRIPTION_PACING_FACTS_SQL,
  SUBSCRIPTION_PACING_WINDOW_LIMIT,
  subscriptionPacingFacts,
} from './subscription-pacing-store.ts'

test('pacing facts plan avoids correlated lists and full run scans', () => {
  const now = Date.now() / 1000
  const plan = db()
    .query<{ detail: string }, [string, number, number, number, number, number, number]>(
      `EXPLAIN QUERY PLAN ${SUBSCRIPTION_PACING_FACTS_SQL}`,
    )
    .all(
      JSON.stringify([{ harness: 'codex', accountId: 'test-account' }]),
      8,
      3,
      now,
      now,
      now,
      now,
    )
    .map((row) => row.detail)

  expect(plan.filter((detail) => detail.includes('CORRELATED LIST SUBQUERY'))).toEqual([])
  expect(plan.filter((detail) => /^SCAN r2?$/.test(detail))).toEqual([])
})

test('pacing facts add post-reading tokens using the latest qualified calibration', () => {
  const now = Date.now()
  const windowMinutes = 10_080
  const resetsAt = Math.floor((now + windowMinutes * 60_000 * 0.9) / 1000)
  db()
    .query(
      `UPDATE run SET quota_used_percent_start=NULL, quota_used_percent_end=NULL,
                      quota_window_minutes=NULL, quota_resets_at=NULL
        WHERE agent='codex'`,
    )
    .run()
  const reading = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 120_000).toISOString(),
  })
  db()
    .query(
      `UPDATE run SET vendor_tokens=1000, quota_account_id='test-account', quota_used_percent_start=10,
                      quota_used_percent_end=20, quota_window_minutes=?, quota_resets_at=?
        WHERE record_id=?`,
    )
    .run(windowMinutes, resetsAt, reading)
  const later = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 60_000).toISOString(),
  })
  db()
    .query(`UPDATE run SET vendor_tokens=2000, quota_account_id='test-account' WHERE record_id=?`)
    .run(later)

  expect(
    subscriptionPacingFacts(db(), new Map([['codex', 'test-account']]), now).get('codex'),
  ).toMatchObject({
    reading: { usedPercentEnd: 20, windowMinutes, resetsAt },
    tokensSinceReading: 2000,
    calibration: { tokensPerPercent: 100, windowMinutes, resetsAt },
  })
})

test('pacing facts use only the selected account and exclude unknown-account rows', () => {
  const now = Date.now()
  const windowMinutes = 10_080
  const resetsAt = Math.floor((now + windowMinutes * 60_000 * 0.9) / 1000)
  for (const [accountId, start, end, tokens] of [
    ['account-a', 1, 51, 5_000],
    ['account-b', 10, 20, 1_000],
  ] as const) {
    const reading = addRun({
      agent: 'codex',
      job: 'understand',
      startedAt: new Date(now - 120_000).toISOString(),
    })
    db()
      .query(
        `UPDATE run SET quota_account_id=?, vendor_tokens=?, quota_used_percent_start=?,
                        quota_used_percent_end=?, quota_window_minutes=?, quota_resets_at=?
          WHERE record_id=?`,
      )
      .run(accountId, tokens, start, end, windowMinutes, resetsAt, reading)
  }
  const knownLater = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 60_000).toISOString(),
  })
  db()
    .query(`UPDATE run SET quota_account_id='account-b', vendor_tokens=2000 WHERE record_id=?`)
    .run(knownLater)
  const unknownLater = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 30_000).toISOString(),
  })
  db().query(`UPDATE run SET vendor_tokens=9000 WHERE record_id=?`).run(unknownLater)

  expect(
    subscriptionPacingFacts(db(), new Map([['codex', 'account-b']]), now).get('codex'),
  ).toMatchObject({
    reading: { usedPercentEnd: 20, windowMinutes, resetsAt },
    tokensSinceReading: 2000,
    calibration: { tokensPerPercent: 100, windowMinutes, resetsAt },
  })
})

test('switching to an account without a reading gives the no-data decision', () => {
  const now = Date.now()
  const reading = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 60_000).toISOString(),
  })
  db()
    .query(
      `UPDATE run SET quota_account_id='account-a', quota_used_percent_start=10,
                      quota_used_percent_end=10, quota_window_minutes=10080,
                      quota_resets_at=? WHERE record_id=?`,
    )
    .run(Math.floor((now + 9_000_000) / 1000), reading)

  const facts = subscriptionPacingFacts(db(), new Map([['codex', 'account-b']]), now).get('codex')!
  expect(
    decideSubscriptionPacing({
      now,
      ...facts,
      writesRepo: false,
      highStakesLens: false,
    }),
  ).toMatchObject({ estimatePercent: null })
})

test('calibration beyond the bounded window search is unavailable', () => {
  const now = Date.now()
  const windowMinutes = 10_080
  const windowSeconds = windowMinutes * 60
  const currentReset = Math.floor((now + windowMinutes * 60_000 * 0.9) / 1000)
  db()
    .query(
      `UPDATE run SET quota_used_percent_start=NULL, quota_used_percent_end=NULL,
                      quota_window_minutes=NULL, quota_resets_at=NULL
        WHERE agent='codex'`,
    )
    .run()

  for (let offset = 0; offset <= SUBSCRIPTION_PACING_WINDOW_LIMIT; offset += 1) {
    const run = addRun({
      agent: 'codex',
      job: 'understand',
      startedAt: new Date(now - (offset + 1) * 60_000).toISOString(),
    })
    const qualifies = offset === SUBSCRIPTION_PACING_WINDOW_LIMIT
    db()
      .query(
        `UPDATE run SET vendor_tokens=1000, quota_account_id='test-account', quota_used_percent_start=?,
                        quota_used_percent_end=21, quota_window_minutes=?, quota_resets_at=?
          WHERE record_id=?`,
      )
      .run(qualifies ? 0 : 21, windowMinutes, currentReset - offset * windowSeconds, run)
  }
  const later = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 30_000).toISOString(),
  })
  db()
    .query(`UPDATE run SET vendor_tokens=2000, quota_account_id='test-account' WHERE record_id=?`)
    .run(later)

  const facts = subscriptionPacingFacts(db(), new Map([['codex', 'test-account']]), now).get(
    'codex',
  )!
  expect(facts).toMatchObject({
    reading: { usedPercentEnd: 21, windowMinutes, resetsAt: currentReset },
    tokensSinceReading: 2000,
    calibration: null,
  })
  expect(
    decideSubscriptionPacing({
      now,
      ...facts,
      writesRepo: false,
      highStakesLens: true,
    })?.estimatePercent,
  ).toBe(21)
})
