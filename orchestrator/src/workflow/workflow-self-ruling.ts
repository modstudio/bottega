// concern: workflows
/** Pure authority decision for an agent closing a workflow step with its own ruling. */

import type { AutonomyValue } from './autonomy.ts'
import type { Floor } from './workflow-floor.ts'

const remedy =
  'use `orch workflow await` and `orch workflow rule` instead, with `--from-operator` where the operator rules'

export function selfRulingRefusal(
  resolvedAutonomy: AutonomyValue,
  floors: Pick<Floor, 'kind' | 'operatorRuling'>[],
): string | null {
  if (resolvedAutonomy !== 'auto' && resolvedAutonomy !== 'review')
    return `self-ruling is refused because resolved autonomy is ${resolvedAutonomy}; ${remedy}`
  if (floors.some((floor) => floor.kind === 'ruling' && floor.operatorRuling))
    return `self-ruling is refused because this step's floor requires an operator ruling; ${remedy}`
  return null
}
