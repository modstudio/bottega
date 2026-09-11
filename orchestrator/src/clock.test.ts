import { afterEach, describe, expect, test } from 'bun:test'
import { clock, fakeClock, registerClock, systemClock } from './clock.ts'

afterEach(() => registerClock(systemClock))

describe('clock', () => {
  test('the registered clock defaults to the system clock and can be replaced', () => {
    expect(clock()).toBe(systemClock)
    const fake = fakeClock(40)
    registerClock(fake)
    expect(clock().now()).toBe(40)
  })

  test('advance fires due timers in deadline then registration order', () => {
    const fake = fakeClock(100)
    const fired: string[] = []
    fake.setTimeout(() => fired.push(`late:${fake.now()}`), 20)
    fake.setTimeout(() => fired.push(`first:${fake.now()}`), 10)
    fake.setTimeout(() => fired.push(`second:${fake.now()}`), 10)
    fake.advance(20)
    expect(fired).toEqual(['first:110', 'second:110', 'late:120'])
    expect(fake.now()).toBe(120)
  })

  test('cancelled timers do not fire and intervals repeat until cleared', () => {
    const fake = fakeClock()
    const fired: number[] = []
    const cancelled = fake.setTimeout(() => fired.push(-1), 5)
    fake.clearTimeout(cancelled)
    let interval: ReturnType<typeof fake.setInterval>
    interval = fake.setInterval(() => {
      fired.push(fake.now())
      if (fired.length === 3) fake.clearInterval(interval)
    }, 4)
    fake.advance(20)
    expect(fired).toEqual([4, 8, 12])
  })
})
