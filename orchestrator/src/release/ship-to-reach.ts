// concern: release reach
/** Decides which release rungs a resolved ship-to level permits. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ShipToValue } from '../../../shared/ship-to.ts'
import { declaredGlobsMatch } from '../review/review-declared-globs.ts'

export type ShipToRung = {
  name: string
  liveVersion?: { command: string; file: string; key: string }
  releasesWhenChanged?: readonly string[]
}
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

export function releaseDepthFlag(depth?: string | null): string {
  return depth ? ` --depth ${depth}` : ''
}

export function shipToRungs(rungs: readonly (ShipToRung & { onDemand?: boolean })[]): ShipToRung[] {
  return rungs
    .filter(({ onDemand }) => !onDemand)
    .map(({ name, releasesWhenChanged }) => ({ name, releasesWhenChanged }))
}

export function shipToDepthRefusal(
  rungs: readonly (ShipToRung & { onDemand?: boolean })[],
  depth: string | undefined,
  project: string,
): string | null {
  if (depth === undefined) return null
  const depthRung = rungs.find(({ name }) => name === depth)
  if (depthRung?.onDemand)
    return `ship-to depth "${depthRung.name}" names a rung released on demand with ${PLATFORM_SLUG} release run ${project} --rung ${depthRung.name} and cannot be a ship-to depth`
  const decision = decideShipToReach('production', shipToRungs(rungs), depth)
  return decision.allowed ? null : decision.refusal
}

export function shipToReachNeedsMergedChange(
  rungs: readonly ShipToRung[],
  reach: readonly string[],
): boolean {
  const reached = new Set(reach)
  return rungs.some(
    ({ name, releasesWhenChanged }) => reached.has(name) && releasesWhenChanged !== undefined,
  )
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
