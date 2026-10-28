// concern: review capture refusal
/** Knows the remedy when a findings run has no captured review. Must not know stores or files. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type ReviewOutputState = 'valid' | 'invalid' | 'missing'

export function reviewCaptureRefusal(runId: string, outputState: ReviewOutputState): string {
  if (outputState === 'valid') {
    return `run ${runId} has no recorded review; recover it with ${PLATFORM_SLUG} review record ${runId}`
  }
  if (outputState === 'invalid') {
    return (
      `run ${runId} output does not satisfy the review contract; ` +
      `score its delivery as none with ${PLATFORM_SLUG} score ${runId} none --note "<why the output failed the contract>"; ` +
      'usable findings can be carried into triage by hand'
    )
  }
  return (
    `run ${runId} has no recorded output; ` +
    `score its delivery as none with ${PLATFORM_SLUG} score ${runId} none --note "<why no output was recorded>"`
  )
}
