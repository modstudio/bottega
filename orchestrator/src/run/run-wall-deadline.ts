// concern: run wall deadline decision
/** Decides when a run's wall bound expires after excluding its brokered gate time. */

export type RunWallDeadlineFacts = {
  boundMs: number
  armedAtMs: number
  accruedGateMs: number
  gateStartedAtMs: number | null
  nowMs: number
  ceilingMs: number
}

export type RunWallDeadlineDecision = { expireNow: true } | { expireNow: false; delayMs: number }

export function excludedGateIntervalMs(
  armedAtMs: number | null,
  gateStartedAtMs: number | null,
  finishedAtMs: number,
): number {
  if (armedAtMs === null || gateStartedAtMs === null) return 0
  return Math.max(0, finishedAtMs - Math.max(armedAtMs, gateStartedAtMs))
}

export function currentExcludedGateMs(
  armedAtMs: number,
  accruedGateMs: number,
  gateStartedAtMs: number | null,
  nowMs: number,
): number {
  return Math.max(0, accruedGateMs) + excludedGateIntervalMs(armedAtMs, gateStartedAtMs, nowMs)
}

export function appendGateExclusionToTimeoutError(
  error: string | null,
  timedOut: boolean,
  excludedGateMs: number,
): string | null {
  if (!error || !timedOut || excludedGateMs <= 0) return error
  return `${error}; excluded ${Math.round(excludedGateMs)}ms of brokered gate time`
}

export function gateExclusionNoteSuffix(excludedGateMs: number): string {
  return excludedGateMs > 0
    ? `; excluded ${Math.round(excludedGateMs)}ms of brokered gate time.`
    : '.'
}

export function decideRunWallDeadline(facts: RunWallDeadlineFacts): RunWallDeadlineDecision {
  const excludedGateMs = currentExcludedGateMs(
    facts.armedAtMs,
    facts.accruedGateMs,
    facts.gateStartedAtMs,
    facts.nowMs,
  )
  const deadlineMs = facts.armedAtMs + Math.min(facts.boundMs + excludedGateMs, facts.ceilingMs)
  const delayMs = deadlineMs - facts.nowMs
  return delayMs <= 0 ? { expireNow: true } : { expireNow: false, delayMs }
}
