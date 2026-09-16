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

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle),
}

export function clock(): Clock {
  return systemClock
}
