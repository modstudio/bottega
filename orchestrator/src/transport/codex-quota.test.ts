import { expect, test } from 'bun:test'
import { parseCodexQuotaReadings } from './codex-quota.ts'
import { EMPTY_QUOTA_READINGS } from './quota-readings.ts'

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
  expect(parseCodexQuotaReadings('{garbled}\n{"type":"event_msg"}')).toEqual(EMPTY_QUOTA_READINGS)
})

test('uses the first reading from the last quota window when a turn crosses a reset', () => {
  const earlierReset = 1_793_774_132
  const laterReset = 1_794_378_932
  expect(
    parseCodexQuotaReadings(
      [
        tokenCount(99, 10_080, earlierReset),
        tokenCount(1, 10_080, laterReset),
        tokenCount(2, 10_080, laterReset),
      ].join('\n'),
    ),
  ).toEqual({
    quotaUsedPercentStart: 1,
    quotaUsedPercentEnd: 2,
    quotaWindowMinutes: 10_080,
    quotaResetsAt: laterReset,
  })
})
