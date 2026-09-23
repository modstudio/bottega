/** Pure stalled-run classification and the operator-facing fact it supports. */

/**
 * Measured from a copy of the live store on 2026-09-22. Among 2,197 successful
 * runs with event logs, the longest silent gap per run was p50=1.31m,
 * p90=4.48m, and max=22.78m. Twenty-five minutes clears the observed maximum
 * while reporting before the default external-wait idle bound.
 */
const DEFAULT_IDLE_STALL_MS = 25 * 60_000

export type StalledRunState = 'healthy' | 'stalled' | 'unknown'

export function idleStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCH_IDLE_STALL_MS
  if (raw === undefined || raw === '') return DEFAULT_IDLE_STALL_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_STALL_MS
}

/** Decide liveness from observations only; an unavailable CPU observation is never a stall. */
export function stalledRunState(input: {
  idleMs: number | null
  cpuMoving: boolean | null
  idleBoundMs: number
  thresholdMs: number
}): StalledRunState {
  if (input.idleMs === null || input.cpuMoving === null) return 'unknown'
  if (input.cpuMoving) return 'healthy'
  return input.idleMs >= Math.min(input.thresholdMs, input.idleBoundMs) ? 'stalled' : 'healthy'
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = ms / 60_000
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`
}

export function stalledRunDetail(input: {
  id: number
  agent: string
  job: string
  idleMs: number
  idleBoundMs: number
}): string {
  return (
    `run ${input.id} ${input.agent}/${input.job} has been silent for ${duration(input.idleMs)} ` +
    `and has used no CPU in that time; stop it and re-dispatch, or wait for the ` +
    `${duration(input.idleBoundMs)} idle bound`
  )
}
