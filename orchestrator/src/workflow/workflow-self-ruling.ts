// concern: workflows
/** Pure authority decision for an agent closing a workflow step with its own ruling. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { AutonomyValue } from './autonomy.ts'
import { type Floor, flagForFloor, mayCloseOnAgentSelfRuling } from './workflow-floor.ts'

const remedy = `use \`${PLATFORM_SLUG} workflow await\` and \`${PLATFORM_SLUG} workflow rule\` instead, with \`--from-operator\` where the operator rules`

function operatorRulingRefusal(floors: Pick<Floor, 'kind' | 'operatorRuling'>[]): string {
  const alternatives = floors.filter((floor) => floor.kind !== 'ruling')
  if (alternatives.length === 0)
    return `self-ruling is refused because this step's floor requires an operator ruling; ${remedy}`
  const named = alternatives.map((floor) => flagForFloor(floor.kind)).join('; ')
  return `self-ruling is refused because this step's ruling floor requires an operator ruling; close with no ruling using ${named}; an operator ruling is needed only when that other evidence does not close the step — ${remedy}`
}

export function selfRulingRefusal(
  resolvedAutonomy: AutonomyValue,
  floors: Pick<Floor, 'kind' | 'operatorRuling'>[],
  basis: string,
): string | null {
  if (
    !mayCloseOnAgentSelfRuling(
      {
        floor: floors.map((floor) => floor.kind),
        operatorRuling: floors.some((floor) => floor.kind === 'ruling' && floor.operatorRuling),
      },
      undefined,
    ) &&
    !floors.some((floor) => floor.kind === 'ruling' && floor.operatorRuling)
  )
    return 'self-ruling is refused because this step has no ruling floor; this step is closed with the evidence its floor names'
  if (resolvedAutonomy !== 'auto' && resolvedAutonomy !== 'review')
    return `self-ruling is refused because resolved autonomy is ${resolvedAutonomy}; ${remedy}`
  if (floors.some((floor) => floor.kind === 'ruling' && floor.operatorRuling))
    return operatorRulingRefusal(floors)
  if (!basis.trim())
    return `self-ruling is refused because it names no basis; pass --basis naming the canon rule, specification line or recorded operator ruling it rests on, or put the question to the operator with \`${PLATFORM_SLUG} workflow await\` and \`${PLATFORM_SLUG} workflow rule --from-operator\``
  return null
}
