// concern: review-lens-provenance
/** Pure policy for deciding whether review-lens provenance names its dispatched subject. */

import { isAbsolute, relative } from 'node:path'
import type { ReviewLensInputStatus } from '../database/review-lens-input-artifact.ts'
import { unavailableReason } from '../database/review-lens-input-artifact.ts'
import type { ReviewLensOwedReason } from './review-vocabulary.ts'

export type LensProvenanceSubjectFacts = {
  recorded: boolean
  treeInspected: string | null
  runTree: string | null
  reviewedCommit: string | null
  headCommit: string | null
}

export type LensProvenanceSubject =
  | { admissible: true }
  | { admissible: false; reason: ReviewLensOwedReason }

export type ReviewedCommitComparison = 'equal' | 'prefix' | 'different' | 'missing'

const GIT_DEFAULT_ABBREVIATION_LENGTH = 7

/** Compare claimed review provenance with the full commit recorded at dispatch. */
export function compareReviewedCommit(
  expected: string,
  reviewed: string | null | undefined,
): ReviewedCommitComparison {
  const claim = reviewed?.trim().toLowerCase()
  if (!claim) return 'missing'
  const recorded = expected.toLowerCase()
  if (!/^[0-9a-f]+$/.test(claim)) return 'different'
  if (claim === recorded) return 'equal'
  return claim.length >= GIT_DEFAULT_ABBREVIATION_LENGTH && recorded.startsWith(claim)
    ? 'prefix'
    : 'different'
}

function pathIsAtOrInside(path: string, root: string): boolean {
  const remainder = relative(root, path)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

/** Whether one lens's recorded provenance names the run subject it was given. */
export function lensProvenanceSubject(
  facts: LensProvenanceSubjectFacts | undefined,
): LensProvenanceSubject {
  if (!facts?.recorded) return { admissible: true }
  if (facts.treeInspected) {
    if (!facts.runTree) return { admissible: false, reason: 'tree-mismatch' }
    if (!pathIsAtOrInside(facts.treeInspected, facts.runTree)) {
      return { admissible: false, reason: 'tree-mismatch' }
    }
  }
  const comparison = facts.headCommit
    ? compareReviewedCommit(facts.headCommit, facts.reviewedCommit)
    : 'missing'
  if (comparison !== 'equal' && comparison !== 'prefix') {
    return { admissible: false, reason: 'commit-mismatch' }
  }
  return { admissible: true }
}

export type ProvenanceLensRow = {
  lens?: string
  graded: boolean
  provenance?: LensProvenanceSubjectFacts
  taskTextInput?: ReviewLensInputStatus | null
  rulingsInput?: ReviewLensInputStatus | null
}

/** Why decision-conformance lacks one of the pack inputs that defines its subject. */
function lensInputReason(row: ProvenanceLensRow): ReviewLensOwedReason | null {
  if (row.lens !== 'decision-conformance') return null
  const reason = unavailableReason(row.taskTextInput) ?? unavailableReason(row.rulingsInput)
  return reason ? `decision-conformance not admitted: ${reason}` : null
}

/** Why a graded lens row cannot count as evidence, or null when it can. */
export function inadmissibleLensReason(row: ProvenanceLensRow): ReviewLensOwedReason | null {
  if (!row.graded) return null
  const subject = lensProvenanceSubject(row.provenance)
  if (!subject.admissible) return subject.reason
  return lensInputReason(row)
}

/** Whether a row is named, graded evidence for its recorded review subject. */
export function countsAsLensEvidence(
  row: ProvenanceLensRow,
): row is ProvenanceLensRow & { lens: string; graded: true } {
  return Boolean(row.lens && row.graded && inadmissibleLensReason(row) === null)
}

/** Whether a row's provenance names its recorded review subject. */
export function hasAdmissibleProvenance(row: ProvenanceLensRow): boolean {
  return lensProvenanceSubject(row.provenance).admissible
}

/** Find the first inadmissible graded row in a newest-first lens sequence. */
export function newestInadmissibleLensRow(
  rows: readonly ProvenanceLensRow[],
  lens?: string,
): { row: ProvenanceLensRow; reason: ReviewLensOwedReason } | null {
  for (const row of rows) {
    if (lens !== undefined && row.lens !== lens) continue
    const reason = inadmissibleLensReason(row)
    if (reason) return { row, reason }
  }
  return null
}
