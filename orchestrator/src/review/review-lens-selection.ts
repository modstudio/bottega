// concern: review-lens-selection
/** Reads the funnel selection reason carried on a run's dispatch metadata. */

import { readDispatchState } from '../run/run-artifacts.ts'
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

/** Reason stored on the run at dispatch; missing metadata is operator-ordered. */
export function lensSelectionReasonFromDispatch(runId: string): ReviewLensSelectionReason {
  return asSelectionReason(readDispatchState(runId).selectionReason) ?? OPERATOR_ORDERED
}
