// concern: review-commands
/** Adapts the exceptional completed-review amendment verb to review triage. */
import { amendFinding, DISPOSITIONS, type Disposition } from './review-triage.ts'
import { REVIEW_SEVERITY } from './review-vocabulary.ts'

type ReviewFlags = { flag(name: string): string | undefined }
type ReviewPresentation = { log(...values: unknown[]): void }

export function amendReviewFindingCommand(
  argv: string[],
  flags: ReviewFlags,
  presentation: ReviewPresentation,
): void {
  const reviewId = Number(argv[2])
  const finding = Number(argv[3])
  const disposition = argv[4] as Disposition
  if (!reviewId || !finding || !DISPOSITIONS.includes(disposition)) {
    throw new Error(
      `orch review amend <review-id> <finding> <accepted|modified|rejected|skipped> [--category X] [--severity ${REVIEW_SEVERITY.join('|')}] --reason <text>`,
    )
  }
  amendFinding(
    reviewId,
    finding,
    disposition,
    flags.flag('reason') ?? '',
    flags.flag('category'),
    flags.flag('severity'),
  )
  presentation.log(`amended review ${reviewId} finding ${finding}: ${disposition}`)
}
