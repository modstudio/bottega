// concern: workflows
/** Decides which release rungs a resolved ship-to level permits. */

import type { ShipToValue } from '../../../shared/ship-to.ts'
import { declaredGlobsMatch } from '../review/review-declared-globs.ts'

export type ShipToRung = { name: string; releasesWhenChanged?: readonly string[] }
type SkippedShipToRung = { name: string; reason: string }

export type ShipToReachDecision =
  | {
      allowed: true
      mayMerge: boolean
      reach: string[]
      remaining: string[]
      skipped: SkippedShipToRung[]
    }
  | { allowed: false; refusal: string }

export function shipToRungs(
  rungs: readonly (ShipToRung & { onDemand?: boolean })[],
): ShipToRung[] {
  return rungs
    .filter(({ onDemand }) => !onDemand)
    .map(({ name, releasesWhenChanged }) => ({ name, releasesWhenChanged }))
}

export function decideShipToReach(
  level: ShipToValue,
  rungs: readonly ShipToRung[],
  depth?: string,
  merge?: { changedPaths: readonly string[] },
): ShipToReachDecision {
  const rungNames = rungs.map(({ name }) => name)
  if (level !== 'production')
    return {
      allowed: true,
      mayMerge: level === 'trunk',
      reach: [],
      remaining: rungNames,
      skipped: [],
    }

  let reachedRungs: readonly ShipToRung[]
  let remaining: string[]
  if (depth === undefined) {
    reachedRungs = rungs
    remaining = []
  } else {
    const lastReached = rungNames.indexOf(depth)
    if (lastReached === -1) {
      return {
        allowed: false,
        refusal: `ship-to depth "${depth}" names no registered release rung; registered rungs: ${rungNames.join(', ') || 'none'}; pass a registered rung name or omit depth`,
      }
    }
    reachedRungs = rungs.slice(0, lastReached + 1)
    remaining = rungNames.slice(lastReached + 1)
  }

  const skipped: SkippedShipToRung[] = []
  const reach = reachedRungs.flatMap((rung) => {
    if (
      merge &&
      rung.releasesWhenChanged !== undefined &&
      !declaredGlobsMatch(merge.changedPaths, rung.releasesWhenChanged)
    ) {
      skipped.push({
        name: rung.name,
        reason: `no release artifact in this change: no changed path matches ${rung.releasesWhenChanged.join(', ')}`,
      })
      return []
    }
    return [rung.name]
  })
  return {
    allowed: true,
    mayMerge: true,
    reach,
    remaining,
    skipped,
  }
}
