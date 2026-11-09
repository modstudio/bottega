type WatchCycle = 'fast' | 'slow'
export type WatchTick = WatchCycle | null
export type WatchRunningCycle = 'initial' | WatchCycle | null

export type WatchCycleDecision = {
  run: WatchCycle | null
  slowOwed: boolean
}

/** Decide which cycle starts without knowing timers, leases, or collection work. */
export function watchCycleDecision(input: {
  running: WatchRunningCycle
  slowOwed: boolean
  tick: WatchTick
  stopping: boolean
}): WatchCycleDecision {
  if (input.stopping) return { run: null, slowOwed: input.slowOwed }
  const slowOwed = input.slowOwed || (input.tick === 'slow' && input.running === 'fast')
  if (input.running !== null) return { run: null, slowOwed }
  if (input.slowOwed) return { run: 'slow', slowOwed: false }
  if (input.tick === 'slow') return { run: 'slow', slowOwed: false }
  return { run: input.tick === 'fast' ? 'fast' : null, slowOwed: false }
}
