import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { candidates } from './route.ts'

test('candidates pace codex reading work but never implementation', () => {
  const now = Date.now()
  const windowMinutes = 10_080
  const resetsAt = Math.floor((now + windowMinutes * 60_000 * 0.9) / 1000)
  const reading = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: new Date(now - 60_000).toISOString(),
  })
  db()
    .query(
      `UPDATE run SET vendor_tokens=1000, quota_used_percent_start=21,
                      quota_used_percent_end=21, quota_window_minutes=?, quota_resets_at=?
        WHERE record_id=?`,
    )
    .run(windowMinutes, resetsAt, reading)

  expect(candidates('understand').find((candidate) => candidate.agent === 'codex')).toMatchObject({
    eligible: false,
    why: expect.stringContaining('ahead of'),
    subscriptionPacingHold: { estimatePercent: 21 },
  })
  expect(candidates('implement').find((candidate) => candidate.agent === 'codex')).toMatchObject({
    eligible: true,
    subscriptionPacingHold: null,
  })
})
