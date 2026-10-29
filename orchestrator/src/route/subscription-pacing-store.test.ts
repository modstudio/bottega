import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { decideSubscriptionPacing } from './subscription-pacing.ts'
import {
  SUBSCRIPTION_PACING_WINDOW_LIMIT,
  subscriptionPacingFacts,
} from './subscription-pacing-store.ts'

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
      `UPDATE run SET vendor_tokens=1000, quota_used_percent_start=10,
                      quota_used_percent_end=20, quota_window_minutes=?, quota_resets_at=?
        WHERE record_id=?`,
    )
    .run(windowMinutes, resetsAt, reading)
  const later = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 60_000).toISOString(),
  })
  db().query(`UPDATE run SET vendor_tokens=2000 WHERE record_id=?`).run(later)

  expect(subscriptionPacingFacts(db(), ['codex'], now).get('codex')).toMatchObject({
    reading: { usedPercentEnd: 20, windowMinutes, resetsAt },
    tokensSinceReading: 2000,
    calibration: { tokensPerPercent: 100, windowMinutes, resetsAt },
  })
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
        `UPDATE run SET vendor_tokens=1000, quota_used_percent_start=?,
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
  db().query(`UPDATE run SET vendor_tokens=2000 WHERE record_id=?`).run(later)

  const facts = subscriptionPacingFacts(db(), ['codex'], now).get('codex')!
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
