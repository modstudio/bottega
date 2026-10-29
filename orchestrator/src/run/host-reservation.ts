// concern: host-capacity reservation policy
/** Knows how much CPU capacity historical samples reserve. Must not know storage or time. */

/** The floor leaves headroom for agents whose measured CPU use is very small. */
export const HOST_RESERVATION_FLOOR_CORES = 0.25
/** Sparse evidence reserves a full core until the estimate is reliable. */
export const HOST_RESERVATION_MIN_SAMPLES = 20
/** The high percentile covers ordinary variation without letting outliers exceed one core. */
export const HOST_RESERVATION_PERCENTILE = 0.95
/** Two weeks keeps the estimate current while retaining enough completed runs. */
export const HOST_RESERVATION_EVIDENCE_DAYS = 14

export type HostReservationSample = {
  startedAt: string
  latencyMs: number
  agentStartTime: string
  resourceCpuMs: number
}

/** Measure CPU cores over agent-active wall time, excluding pre-spawn host waiting. */
export function activeCores(sample: HostReservationSample): number | null {
  const startedAt = Date.parse(sample.startedAt)
  const agentStartedAt = Date.parse(sample.agentStartTime)
  if (!Number.isFinite(startedAt) || !Number.isFinite(agentStartedAt)) return null
  const activeMs = startedAt + sample.latencyMs - agentStartedAt
  if (activeMs <= 0) return null
  return sample.resourceCpuMs / activeMs
}

/** Reserve the bounded nearest-rank percentile of measured CPU-core use. */
export function reservedCores(samples: number[]): number {
  if (samples.length < HOST_RESERVATION_MIN_SAMPLES) return 1
  const ordered = [...samples].sort((left, right) => left - right)
  const rank = Math.ceil(HOST_RESERVATION_PERCENTILE * ordered.length)
  return Math.max(HOST_RESERVATION_FLOOR_CORES, Math.min(1, ordered[rank - 1]!))
}
