// concern: review-commands
/** Adapts the exceptional completed-review amendment verb to review triage. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { getReview } from './review.ts'
import { resolveReviewIdentifier } from './review-identifier.ts'
import { amendFinding, DISPOSITIONS, type Disposition } from './review-triage.ts'
import { REVIEW_SEVERITY } from './review-vocabulary.ts'

type ReviewFlags = { flag(name: string): string | undefined }
type ReviewPresentation = { log(...values: unknown[]): void }

export function amendReviewFindingCommand(
  argv: string[],
  flags: ReviewFlags,
  presentation: ReviewPresentation,
): void {
  const reviewInput = argv[2]
  const finding = Number(argv[3])
  const disposition = argv[4] as Disposition
  if (!reviewInput || !finding || !DISPOSITIONS.includes(disposition)) {
    throw new Error(
      `${PLATFORM_SLUG} review amend <review-id> <finding> <accepted|modified|rejected|skipped> [--category X] [--severity ${REVIEW_SEVERITY.join('|')}] --reason <text>`,
    )
  }
  const reviewRecordId = resolveReviewIdentifier(db(), reviewInput)
  amendFinding(
    reviewRecordId,
    finding,
    disposition,
    flags.flag('reason') ?? '',
    flags.flag('category'),
    flags.flag('severity'),
  )
  presentation.log(`amended finding ${getReview(reviewRecordId).number}/${finding}: ${disposition}`)
}
