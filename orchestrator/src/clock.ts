// concern: clock
/** Time and timer primitives. Knows no orchestrator concern. */

export type ClockHandle = ReturnType<typeof globalThis.setTimeout>

export type Clock = {
  now(): number
  setTimeout(fn: () => void, ms: number): ClockHandle
  clearTimeout(handle: ClockHandle): void
  setInterval(fn: () => void, ms: number): ClockHandle
  clearInterval(handle: ClockHandle): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle),
}

let registeredClock: Clock = systemClock

export function registerClock(value: Clock): void {
  registeredClock = value
}

export function clock(): Clock {
  return registeredClock
}

export type FakeClock = Clock & { advance(ms: number): void }

type FakeTimer = {
  id: number
  due: number
  interval: number | null
  fn: () => void
}

export function fakeClock(start = 0): FakeClock {
  let current = start
  let nextId = 1
  const timers = new Map<number, FakeTimer>()
  const schedule = (fn: () => void, ms: number, interval: number | null): ClockHandle => {
    const id = nextId++
    timers.set(id, { id, due: current + Math.max(0, ms), interval, fn })
    return id as unknown as ClockHandle
  }
  const clear = (handle: ClockHandle): void => {
    timers.delete(handle as unknown as number)
  }
  return {
    now: () => current,
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: clear,
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, ms)),
    clearInterval: clear,
    advance(ms) {
      if (ms < 0) throw new Error('fake clock cannot advance backwards')
      const target = current + ms
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0]
        if (!due) break
        current = due.due
        if (due.interval === null) timers.delete(due.id)
        else due.due += due.interval
        due.fn()
      }
      current = target
    },
  }
}
