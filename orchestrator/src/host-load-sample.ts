// concern: host-load sampling
/** One host-load sample, including orchestrator liveness, for provisioning and monitoring. */
import type { Database } from 'bun:sqlite'
import { liveRuns } from './database/db.ts'
import { type HostLoad, measureHostLoad } from './gate-load.ts'

export type HostLoadSample = HostLoad & { liveRuns: number }

export function sampleHostLoad(database?: Database): HostLoadSample {
  return { ...measureHostLoad(), liveRuns: liveRuns(database).length }
}
