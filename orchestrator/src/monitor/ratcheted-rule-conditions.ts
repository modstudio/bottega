// concern: monitor-ratcheted-rule-conditions
/** Builds report-only conditions for mechanical-rule debt that drained and refilled. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type CategoryExecutionRow,
  categoryExecutionRows,
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
      action: `report only; inspect ${PLATFORM_SLUG} gate enforcement --project ${project.name}`,
      affectedProject: project.name,
    })),
  )
}

/** Read refill history without letting an unavailable local observation imply no conditions. */
export function observeRatchetedRuleRefills(
  projects: readonly Pick<Project, 'name' | 'path'>[],
  database: Database,
): { conditions: MonitorCondition[]; errors: string[] } {
  try {
    return {
      conditions: ratchetedRuleRefillConditions(projects, categoryExecutionRows(database)),
      errors: [],
    }
  } catch (cause) {
    return {
      conditions: [],
      errors: [`ratcheted rule history unavailable: ${String((cause as Error).message ?? cause)}`],
    }
  }
}
