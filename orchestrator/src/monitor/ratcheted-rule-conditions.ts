// concern: monitor-ratcheted-rule-conditions
/** Builds report-only conditions for mechanical-rule debt that drained and refilled. */

import {
  type CategoryExecutionRow,
  refilledCategoryExecutions,
} from '../enforcement/enforcement-records.ts'
import type { Project } from '../project/projects.ts'
import type { MonitorCondition } from './monitor-types.ts'

/** Report each category whose newest eligible count rose above an earlier zero. */
export function ratchetedRuleRefillConditions(
  projects: readonly Pick<Project, 'name' | 'path'>[],
  rows: readonly CategoryExecutionRow[],
): MonitorCondition[] {
  return projects.flatMap((project) =>
    refilledCategoryExecutions(rows, project.path).map((refill) => ({
      kind: 'ratcheted-rule-refilled',
      subject: `${project.name}:${refill.category}`,
      since: refill.finishedAt,
      ageMs: null,
      detail: `${refill.category} has ${refill.remaining} remaining findings; the last gate that recorded zero finished at ${refill.lastZeroFinishedAt}`,
      action: `report only; inspect orch enforcement --project ${project.name}`,
      affectedProject: project.name,
    })),
  )
}
