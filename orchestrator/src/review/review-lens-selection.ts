// concern: review-lens-selection
/** Reads and writes the funnel selection reason carried as dispatch metadata. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import {
  REVIEW_LENS_SELECTION_REASON,
  type ReviewLensSelectionReason,
} from './review-vocabulary.ts'

const OPERATOR_ORDERED: ReviewLensSelectionReason = 'operator-ordered'

function asSelectionReason(value: string | null | undefined): ReviewLensSelectionReason | null {
  return REVIEW_LENS_SELECTION_REASON.includes(value as ReviewLensSelectionReason)
    ? (value as ReviewLensSelectionReason)
    : null
}

const selectionReasonPath = (runId: string) => join(RUNS_DIR, runId, 'selection-reason')

/** Persist the funnel reason on the run so recordReviews can store it. */
export function writeLensSelectionReason(runId: string, reason: string): void {
  mkdirSync(join(RUNS_DIR, runId), { recursive: true })
  writeFileSync(selectionReasonPath(runId), reason)
}

/** Reason stored on the run at dispatch; missing metadata is operator-ordered. */
export function lensSelectionReasonFromDispatch(runId: string): ReviewLensSelectionReason {
  const path = selectionReasonPath(runId)
  if (!existsSync(path)) return OPERATOR_ORDERED
  return asSelectionReason(readFileSync(path, 'utf8').trim()) ?? OPERATOR_ORDERED
}
