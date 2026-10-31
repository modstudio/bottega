import { describe, expect, test } from 'bun:test'
import {
  decideToolCallBurst,
  TOOL_CALL_BURST_LIMIT,
  TOOL_CALL_BURST_WINDOW_MS,
  toolCallBurstAction,
} from './tool-call-burst.ts'

const burst = (count: number, durationMs = TOOL_CALL_BURST_WINDOW_MS) =>
  Array.from({ length: count }, (_, index) => (index * durationMs) / Math.max(1, count - 1))

describe('tool-call burst class guard', () => {
  test.each([
    ['2,303 starts in one second', burst(2303), true],
    ['64 starts in one second', burst(64), true],
    ['limit + 1 in one window', burst(TOOL_CALL_BURST_LIMIT + 1), true],
    ['exactly limit in one window', burst(TOOL_CALL_BURST_LIMIT), false],
    ['highest normal goose batch', burst(22), false],
    [
      'steady 12 starts per second for 30 seconds',
      Array.from({ length: 30 * 12 }, (_, index) => index * (1000 / 12)),
      false,
    ],
    ['resume replay contributes no live starts', [], false],
  ] as const)('%s', (_name, starts, tripped) => {
    expect(decideToolCallBurst(starts).tripped).toBe(tripped)
  })

  test('the harness choice kills goose and only observes codex', () => {
    expect(decideToolCallBurst(burst(64)).tripped).toBe(true)
    expect(toolCallBurstAction('goose')).toBe('kill')
    expect(toolCallBurstAction('codex')).toBe('observe')
  })
})
