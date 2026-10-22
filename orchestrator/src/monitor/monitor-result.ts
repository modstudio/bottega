// concern: monitor
/** Constructs the completed monitor result without adding more shape work to the frozen pass. */

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
  return { id, startedAt, finishedAt, trigger, conditions, errors, canon, hostLoad, hostPressure }
}
