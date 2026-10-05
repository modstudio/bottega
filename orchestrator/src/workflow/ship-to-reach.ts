// concern: workflows
/** Decides which release rungs a resolved ship-to level permits. */

import type { ShipToValue } from '../../../shared/ship-to.ts'

export type ShipToReachDecision =
  | { allowed: true; mayMerge: boolean; reach: string[]; remaining: string[] }
  | { allowed: false; refusal: string }

export function decideShipToReach(
  level: ShipToValue,
  rungs: readonly string[],
  depth?: string,
): ShipToReachDecision {
  if (level !== 'production')
    return { allowed: true, mayMerge: level === 'trunk', reach: [], remaining: [...rungs] }

  if (depth === undefined)
    return { allowed: true, mayMerge: true, reach: [...rungs], remaining: [] }

  const lastReached = rungs.indexOf(depth)
  if (lastReached === -1) {
    return {
      allowed: false,
      refusal: `ship-to depth "${depth}" names no registered release rung; registered rungs: ${rungs.join(', ') || 'none'}; pass a registered rung name or omit depth`,
    }
  }
  return {
    allowed: true,
    mayMerge: true,
    reach: rungs.slice(0, lastReached + 1),
    remaining: rungs.slice(lastReached + 1),
  }
}
