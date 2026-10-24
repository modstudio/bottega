// concern: database write probe
/** Names probe tables and classifies their process owners. Must not know schema lifecycle or connection policy. */
export const WRITE_PROBE_TABLE_PREFIX = '__orch_write_probe_'

/** A probe table has the reserved prefix followed by an all-digit process id. */
export function isWriteProbeTable(name: string): boolean {
  const suffix = name.slice(WRITE_PROBE_TABLE_PREFIX.length)
  return name.startsWith(WRITE_PROBE_TABLE_PREFIX) && /^\d+$/.test(suffix)
}

/** Read the owner from a name already accepted by isWriteProbeTable. */
export function writeProbeOwnerPid(name: string): number {
  return Number(name.slice(WRITE_PROBE_TABLE_PREFIX.length))
}

/** A probe is stale only when its observed owner is neither current nor alive. */
export function staleWriteProbe(name: string, currentPid: number, ownerAlive: boolean): boolean {
  if (!isWriteProbeTable(name)) return false
  const pid = writeProbeOwnerPid(name)
  return pid !== currentPid && !ownerAlive
}
