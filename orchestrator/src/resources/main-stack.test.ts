import { expect, test } from 'bun:test'
import { MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT, mainStackIdleStopAfterMs } from './main-stack.ts'

test('main stack idle threshold has a four-hour default and refuses invalid overrides', () => {
  expect(mainStackIdleStopAfterMs({})).toBe(MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT)
  expect(mainStackIdleStopAfterMs({ ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS: '5000' })).toBe(5_000)
  expect(() => mainStackIdleStopAfterMs({ ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS: '0' })).toThrow(
    'ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS',
  )
  expect(() => mainStackIdleStopAfterMs({ ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS: 'later' })).toThrow(
    'ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS',
  )
})
