import { expect, test } from 'bun:test'
import {
  appendGateExclusionToTimeoutError,
  decideRunWallDeadline,
  gateExclusionNoteSuffix,
} from './run-wall-deadline.ts'

const facts = (over: Partial<Parameters<typeof decideRunWallDeadline>[0]> = {}) => ({
  boundMs: 100,
  armedAtMs: 1_000,
  accruedGateMs: 0,
  gateStartedAtMs: null,
  nowMs: 1_100,
  ceilingMs: 1_000,
  ...over,
})

test('the run expires at its configured bound when no gate time was excluded', () => {
  expect(decideRunWallDeadline(facts())).toEqual({ expireNow: true })
})

test('accrued gate time moves expiry by exactly the accrued duration', () => {
  expect(decideRunWallDeadline(facts({ accruedGateMs: 50 }))).toEqual({
    expireNow: false,
    delayMs: 50,
  })
})

test('an in-flight gate excludes its elapsed time at the original bound', () => {
  expect(decideRunWallDeadline(facts({ gateStartedAtMs: 1_050 }))).toEqual({
    expireNow: false,
    delayMs: 50,
  })
})

test('the stale ceiling wins over any amount of excluded gate time', () => {
  expect(decideRunWallDeadline(facts({ accruedGateMs: 10_000, ceilingMs: 100 }))).toEqual({
    expireNow: true,
  })
})

test('a gate finishing after the original bound leaves the run time remaining at gate start', () => {
  expect(
    decideRunWallDeadline(
      facts({
        accruedGateMs: 70,
        nowMs: 1_150,
      }),
    ),
  ).toEqual({ expireNow: false, delayMs: 20 })
})

test('a timeout error records excluded gate time without changing its configured-bound text', () => {
  expect(
    appendGateExclusionToTimeoutError('no reply within 45m; grok was killed', true, 125_000),
  ).toBe('no reply within 45m; grok was killed; excluded 125000ms of brokered gate time')
  expect(appendGateExclusionToTimeoutError('no reply within 45m; grok was killed', true, 0)).toBe(
    'no reply within 45m; grok was killed',
  )
  expect(gateExclusionNoteSuffix(125_000)).toBe('; excluded 125000ms of brokered gate time.')
  expect(gateExclusionNoteSuffix(0)).toBe('.')
})
