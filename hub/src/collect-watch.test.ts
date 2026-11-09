import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { leaseHolder, watch } from './collect.ts'
import { FAST_MS, SLOW_MS } from './collect-cadence.ts'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

test('a slow tick during a busy fast cycle runs once as soon as fast finishes', async () => {
  const intervals: Array<{ callback: () => void; delay: number }> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    intervals.push({ callback, delay: delay ?? 0 })
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const order: string[] = []
  let initialRan!: () => void
  const initialFinished = new Promise<void>((resolve) => (initialRan = resolve))
  let fastStarted!: () => void
  const fastDidStart = new Promise<void>((resolve) => (fastStarted = resolve))
  let finishFast!: () => void
  const fastCanFinish = new Promise<void>((resolve) => (finishFast = resolve))
  let slowRan!: () => void
  const slowFinished = new Promise<void>((resolve) => (slowRan = resolve))
  const stop = watch('owed-slow-watch', undefined, {
    initial: async () => {
      order.push('initial')
      initialRan()
      return undefined
    },
    fast: async () => {
      order.push('fast:start')
      fastStarted()
      await fastCanFinish
      order.push('fast:end')
      return undefined
    },
    slow: async () => {
      order.push('slow')
      slowRan()
      return undefined
    },
  })
  try {
    await initialFinished
    while (leaseHolder() !== null) await Bun.sleep(0)
    await Bun.sleep(0)
    intervals
      .filter((entry) => entry.delay === FAST_MS)
      .at(-1)!
      .callback()
    await fastDidStart
    const slowTick = intervals.find((entry) => entry.delay === SLOW_MS)!.callback
    slowTick()
    slowTick()
    finishFast()
    await slowFinished
    while (leaseHolder() !== null) await Bun.sleep(0)
    await Bun.sleep(0)
    expect(order).toEqual(['initial', 'fast:start', 'fast:end', 'slow'])
  } finally {
    finishFast()
    await stop()
    interval.mockRestore()
  }
})
