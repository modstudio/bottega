// concern: monitor-observation
/** Folds one monitor observation into the pass-level accumulators. */

import type { MonitorCondition } from './monitor-types.ts'

type MonitorObservation = {
  conditions: MonitorCondition[]
  errors: string[]
  notApplicable: string[]
}

export function appendMonitorObservation(
  conditions: MonitorCondition[],
  errors: string[],
  notApplicable: string[],
  observation: MonitorObservation,
): void {
  conditions.push(...observation.conditions)
  errors.push(...observation.errors)
  notApplicable.push(...observation.notApplicable)
}
