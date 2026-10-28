import { expect, test } from 'bun:test'
import { EMPTY_CODEX_QUOTA_READINGS, parseCodexQuotaReadings } from './codex-quota.ts'

const tokenCount = (usedPercent: number, windowMinutes = 10_080, resetsAt = 1_793_774_132) =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: {
          used_percent: usedPercent,
          window_minutes: windowMinutes,
          resets_at: resetsAt,
        },
      },
    },
  })

test('takes the first and last primary quota readings from rollout fixture lines', () => {
  const text = [
    tokenCount(12),
    '{"type":"event_msg","payload":{"type":"message"}}',
    tokenCount(13),
  ].join('\n')
  expect(parseCodexQuotaReadings(text)).toEqual({
    quotaUsedPercentStart: 12,
    quotaUsedPercentEnd: 13,
    quotaWindowMinutes: 10_080,
    quotaResetsAt: 1_793_774_132,
  })
})

test('missing or garbled fixture lines leave quota readings null', () => {
  expect(parseCodexQuotaReadings('{garbled}\n{"type":"event_msg"}')).toEqual(
    EMPTY_CODEX_QUOTA_READINGS,
  )
})
