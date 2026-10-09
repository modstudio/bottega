import { expect, test } from 'bun:test'
import { asInterval } from './hosted-measures.ts'

const INTERVAL_TOKENS = 2_207_932_949

function expectNumber(value: unknown, expected: number) {
  expect(typeof value).toBe('number')
  expect(value).toBe(expected)
}

test('asInterval returns vendor tokens above the 32-bit range as a number', () => {
  const row = {
    task_id: null,
    task_key: 'DEV-1240',
    project_name: 'workshop',
    project_id: null,
    source: 'claude',
    start_at: '2026-10-05T10:00:00.000Z',
    end_at: '2026-10-05T12:00:00.000Z',
    open: 0,
    user_id: null,
    vendor_cost_usd: null,
  }
  expectNumber(
    asInterval({ ...row, vendor_tokens: String(INTERVAL_TOKENS) }).vendorTokens,
    INTERVAL_TOKENS,
  )
  expectNumber(asInterval({ ...row, vendor_tokens: INTERVAL_TOKENS }).vendorTokens, INTERVAL_TOKENS)
})
