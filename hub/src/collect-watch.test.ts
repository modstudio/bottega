import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { acquireLease, leaseHolder, watch } from './collect.ts'
import { FAST_MS, SLOW_MS } from './collect-cadence.ts'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

test('a failed lease acquisition is reported and retried on a later tick', async () => {
  const intervals: Array<{ callback: () => void; delay: number }> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    intervals.push({ callback, delay: delay ?? 0 })
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const lockError = new Error('database is locked')
  const errors: Error[] = []
  let acquisitionCalls = 0
  let slowRan!: () => void
  const slowFinished = new Promise<void>((resolve) => (slowRan = resolve))
  const stop = watch('acquisition-retry-watch', (error) => errors.push(error), {
    acquireLease: (holder) => {
      acquisitionCalls++
      if (acquisitionCalls === 1) throw lockError
      return acquireLease(holder)
    },
    slow: async () => {
      slowRan()
      return undefined
    },
  })
  try {
    const fastTick = intervals.filter((entry) => entry.delay === FAST_MS).at(-1)!.callback
    expect(fastTick).not.toThrow()
    await slowFinished
    expect(errors).toEqual([lockError])
    expect(acquisitionCalls).toBe(2)
  } finally {
    await stop()
    interval.mockRestore()
  }
})

test('a failed initial acquisition makes the slow pass run on the next fast tick', async () => {
  const intervals: Array<{ callback: () => void; delay: number }> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    intervals.push({ callback, delay: delay ?? 0 })
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  let acquisitionCalls = 0
  const legs: string[] = []
  let slowRan!: () => void
  const slowFinished = new Promise<void>((resolve) => (slowRan = resolve))
  const stop = watch('initial-slow-owed-watch', undefined, {
    acquireLease: (holder) => {
      acquisitionCalls++
      if (acquisitionCalls === 1) return false
      return acquireLease(holder)
    },
    fast: async () => {
      legs.push('fast')
      return undefined
    },
    slow: async () => {
      legs.push('slow')
      slowRan()
      return undefined
    },
  })
  try {
    intervals.find((entry) => entry.delay === FAST_MS)!.callback()
    await slowFinished
    expect(legs).toEqual(['slow'])
  } finally {
    await stop()
    interval.mockRestore()
  }
})

test('watch reports lease reads and release failures without throwing', async () => {
  const intervals: Array<{ callback: () => void; delay: number }> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    intervals.push({ callback, delay: delay ?? 0 })
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const readError = new Error('database is locked during lease read')
  const releaseError = new Error('database is locked during lease release')
  const errors: Error[] = []
  let initialStarted!: () => void
  const didStart = new Promise<void>((resolve) => (initialStarted = resolve))
  let finishInitial!: () => void
  const canFinish = new Promise<void>((resolve) => (finishInitial = resolve))
  const stop = watch('store-access-watch', (error) => errors.push(error), {
    leaseHolder: () => {
      throw readError
    },
    releaseLease: () => {
      throw releaseError
    },
    initial: async () => {
      initialStarted()
      await canFinish
      return undefined
    },
  })
  try {
    await didStart
    const fastTick = intervals.filter((entry) => entry.delay === FAST_MS).at(-1)!.callback
    expect(fastTick).not.toThrow()
    expect(errors).toEqual([readError])
    finishInitial()
    await stop()
    expect(errors).toEqual([readError, releaseError])
  } finally {
    finishInitial()
    interval.mockRestore()
  }
})

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
