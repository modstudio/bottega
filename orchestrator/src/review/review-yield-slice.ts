// concern: review-yield-slice
/**
 * Knows how a lens run is placed on the yield change-area, risk and size
 * axes, and which findings count as medium-or-higher accepted value.
 * Must not know the store, clocks, or processes.
 */

import type { ReviewSettings } from '../project/project-injection.ts'
import { declaredGlobsMatch } from './review-declared-globs.ts'
import {
  REVIEW_FILE_COUNT_BUMP_REASON,
  REVIEW_SEVERITY,
  type ReviewSeverity,
} from './review-vocabulary.ts'

export const NO_DECLARED_GLOB = '(no declared glob)'
export const UNRECORDED_SLICE = 'unrecorded'

const MEDIUM_PLUS = REVIEW_SEVERITY.slice(0, 3)

export type YieldFinding = {
  disposition: string | null
  triaged_severity: string | null
}

/**
 * Concerns whose declared globs match any path in the review's path_set.
 * Unscoped lenses are not areas. A path_set may belong to several concerns;
 * none matching is the residual.
 */
export function yieldPathAreas(
  paths: readonly string[],
  lenses: ReviewSettings['lenses'],
): string[] {
  const areas: string[] = []
  for (const entry of lenses) {
    if (!entry.paths?.length) continue
    if (!declaredGlobsMatch(paths, entry.paths)) continue
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

export function yieldDeletionShareKey(
  lens: string,
  insertions: number | null,
  deletions: number | null,
): string {
  const total = insertions === null || deletions === null ? 0 : insertions + deletions
  const share =
    insertions === null || deletions === null || total === 0
      ? 'unknown'
      : deletions * 3 >= total * 2
        ? 'deletion-heavy'
        : insertions * 3 >= total * 2
          ? 'addition-heavy'
          : 'mixed'
  return `${lens} / ${share}`
}

export function yieldFileCountBumpKey(lens: string, reasons: string | null): string {
  return `${lens} / ${reasons?.includes(REVIEW_FILE_COUNT_BUMP_REASON) ? 'bumped' : 'not bumped'}`
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
