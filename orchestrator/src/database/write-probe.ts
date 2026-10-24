// concern: database write probe
/** Names probe tables and classifies their process owners. Must not know schema lifecycle or connection policy. */
import { pidAlive } from '../../../shared/process-identity.ts'

export const WRITE_PROBE_TABLE_PREFIX = '__orch_write_probe_'

/** A probe is stale only when its suffix is a numeric pid that is neither current nor alive. */
export function staleWriteProbe(name: string, currentPid: number): boolean {
  const suffix = name.slice(WRITE_PROBE_TABLE_PREFIX.length)
  if (!/^\d+$/.test(suffix)) return false
  const pid = Number(suffix)
  return pid !== currentPid && !pidAlive(pid)
}
