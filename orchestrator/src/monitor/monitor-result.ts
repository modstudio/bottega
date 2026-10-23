// concern: monitor
/** Constructs the completed monitor result without adding more shape work to the frozen pass. */

import { db } from '../database/db.ts'
import { runHostCapacityQueue } from '../run/run-host-capacity.ts'
import type {
  MonitorCondition,
  MonitorHostLoad,
  MonitorHostPressure,
  MonitorResult,
} from './monitor-types.ts'

export function finishMonitorResult(
  id: number,
  startedAt: string,
  finishedAt: string,
  trigger: MonitorResult['trigger'],
  conditions: MonitorCondition[],
  errors: string[],
  canon: MonitorResult['canon'],
  hostLoad: MonitorHostLoad,
  hostPressure: MonitorHostPressure,
): MonitorResult {
  return {
    id,
    startedAt,
    finishedAt,
    trigger,
    conditions,
    errors,
    canon,
    hostLoad,
    hostPressure,
    runHostCapacity: runHostCapacityQueue(db(), Date.parse(finishedAt), {
      measure: () => hostLoad,
    }),
  }
}
