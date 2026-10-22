// concern: review-yield-slice
/**
 * Knows how a lens run is placed on the yield change-area, risk and size
 * axes, and which findings count as medium-or-higher accepted value.
 * Must not know the store, clocks, or processes.
 */

import { REVIEW_SEVERITY, type ReviewSeverity } from './review-vocabulary.ts'

export const NO_DECLARED_GLOB = '(no declared glob)'
export const UNRECORDED_SLICE = 'unrecorded'

const MEDIUM_PLUS = REVIEW_SEVERITY.slice(0, 3)

export type YieldLensDeclaration = {
  lens: string
  paths?: readonly string[]
}

export type YieldFinding = {
  disposition: string | null
  triaged_severity: string | null
}

/** Declared path-scoped lenses from a project settings JSON blob. */
export function yieldLensDeclarations(projectSettings: string | null): YieldLensDeclaration[] {
  if (!projectSettings) return []
  try {
    const parsed = JSON.parse(projectSettings) as {
      review?: { lenses?: YieldLensDeclaration[] }
    }
    return Array.isArray(parsed.review?.lenses) ? parsed.review.lenses : []
  } catch {
    return []
  }
}

/**
 * Concerns whose declared globs match any path in the review's path_set.
 * Unscoped lenses are not areas. A path_set may belong to several concerns;
 * none matching, or an unreadable path_set, is the residual.
 */
export function yieldPathAreas(
  pathSet: string | null,
  lenses: readonly YieldLensDeclaration[],
): string[] {
  const paths = changedPaths(pathSet)
  const areas: string[] = []
  for (const entry of lenses) {
    if (!entry.paths?.length) continue
    if (!entry.paths.some((pattern) => paths.some((path) => new Bun.Glob(pattern).match(path))))
      continue
    if (areas.includes(entry.lens)) continue
    areas.push(entry.lens)
  }
  return areas.length ? areas : [NO_DECLARED_GLOB]
}

export function yieldSizeKey(lens: string, size: number | null): string {
  return `${lens} / size ${size ?? UNRECORDED_SLICE}`
}

export function yieldRiskKey(lens: string, risk: number | null): string {
  return `${lens} / risk ${risk ?? UNRECORDED_SLICE}`
}

export function yieldAreaKey(lens: string, area: string): string {
  return `${lens} / ${area}`
}

export function isMediumPlusHit(finding: YieldFinding): boolean {
  return (
    (finding.disposition === 'accepted' || finding.disposition === 'modified') &&
    MEDIUM_PLUS.includes(finding.triaged_severity as ReviewSeverity)
  )
}

export function mediumPlusAcceptedCount(findings: readonly YieldFinding[]): number {
  return findings.filter(isMediumPlusHit).length
}

/** Share of complete lens runs with at least one medium-or-higher hit. */
export function mediumPlusAcceptedYield(
  completeRows: readonly { findings: readonly YieldFinding[] }[],
): number | null {
  if (!completeRows.length) return null
  const hits = completeRows.filter((row) => row.findings.some(isMediumPlusHit)).length
  return hits / completeRows.length
}

function changedPaths(pathSet: string | null): string[] {
  if (!pathSet) return []
  try {
    const parsed = JSON.parse(pathSet) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((path): path is string => typeof path === 'string')
  } catch {
    return []
  }
}
