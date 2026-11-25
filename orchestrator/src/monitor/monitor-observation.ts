// concern: monitor-observation
/** Folds one monitor observation into the pass-level accumulators. */

import type { MonitorCondition, MonitorObservation } from './monitor-types.ts'

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
