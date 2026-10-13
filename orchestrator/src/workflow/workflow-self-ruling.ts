// concern: workflows
/** Pure authority decision for an agent closing a workflow step with its own ruling. */

import type { AutonomyValue } from './autonomy.ts'
import type { Floor } from './workflow-floor.ts'

const remedy =
  'use `orch workflow await` and `orch workflow rule` instead, with `--from-operator` where the operator rules'

export function selfRulingRefusal(
  resolvedAutonomy: AutonomyValue,
  floors: Pick<Floor, 'kind' | 'operatorRuling'>[],
  basis: string,
): string | null {
  if (!floors.some((floor) => floor.kind === 'ruling'))
    return 'self-ruling is refused because this step has no ruling floor; this step is closed with the evidence its floor names'
  if (resolvedAutonomy !== 'auto' && resolvedAutonomy !== 'review')
    return `self-ruling is refused because resolved autonomy is ${resolvedAutonomy}; ${remedy}`
  if (floors.some((floor) => floor.kind === 'ruling' && floor.operatorRuling))
    return `self-ruling is refused because this step's floor requires an operator ruling; ${remedy}`
  if (!basis.trim())
    return 'self-ruling is refused because it names no basis; pass --basis naming the canon rule, specification line or recorded operator ruling it rests on, or put the question to the operator with `orch workflow await` and `orch workflow rule --from-operator`'
  return null
}

export function renderSelfRulingResult(
  result: string,
  input: { ruling: string; basis: string } | undefined,
): string {
  return input
    ? `${result}\nSelf-ruling: ${input.ruling.trim()}\nBasis: ${input.basis.trim()}`
    : result
}
