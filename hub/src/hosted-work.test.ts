import { expect, test } from 'bun:test'
import { hostedDayRow, interval } from './hosted-work.ts'

const DAY_TOKENS = 8_338_668_790
const INTERVAL_TOKENS = 2_207_932_949

function expectNumber(value: unknown, expected: number) {
  expect(typeof value).toBe('number')
  expect(value).toBe(expected)
}

test('hosted work rows return token totals above the 32-bit range as numbers', () => {
  const intervalRow = {
    task_key: 'DEV-1240',
    project: 'workshop',
    source: 'claude',
    agent: null,
    job: null,
    start_at: '2026-10-05T10:00:00.000Z',
    end_at: '2026-10-05T12:00:00.000Z',
    vendor_cost_usd: null,
    open: 0,
  }
  for (const tokens of [String(INTERVAL_TOKENS), BigInt(INTERVAL_TOKENS), INTERVAL_TOKENS]) {
    const shapedInterval = interval({
      ...intervalRow,
      claude_tokens: tokens,
      vendor_tokens: tokens,
    })
    expectNumber(shapedInterval.claude_tokens, INTERVAL_TOKENS)
    expectNumber(shapedInterval.vendor_tokens, INTERVAL_TOKENS)
  }

  const dayRow = {
    day: '2026-10-05',
    tasks: 1,
    commits: 0,
    files: 0,
    lines_product: 0,
    lines_test: 0,
    lines_docs: 0,
    lines_config: 0,
    lines_generated: 0,
  }
  for (const tokens of [String(DAY_TOKENS), BigInt(DAY_TOKENS), DAY_TOKENS]) {
    expectNumber(hostedDayRow({ ...dayRow, claude_tokens: tokens }).claude_tokens, DAY_TOKENS)
  }
})
