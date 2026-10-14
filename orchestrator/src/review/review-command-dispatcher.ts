// concern: review-commands
/** Routes exceptional review maintenance verbs, otherwise preserving the frozen review command. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { reviewCommand } from './review-commands.ts'
import { amendReviewFindingCommand } from './review-finding-amend-command.ts'
import { restoreReviewFindingsCommand } from './review-finding-restore.ts'
import { recordArchitectReadCommand } from './review-read.ts'
import { recordProjectReviewCommand } from './review-record-command.ts'
import { reviewBudgetCommand } from './review-round-budget.ts'
import { restoreReviewTriageCommand } from './review-triage-restore.ts'

type ReviewFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}
type ReviewPresentation = { log(...values: unknown[]): void; usage(): never }

function dispatchReadOnlyReviewCommand(
  sub: string | undefined,
  argv: string[],
  flags: ReviewFlags,
  presentation: ReviewPresentation,
): boolean {
  if (sub === 'read') {
    recordArchitectReadCommand(argv, flags, presentation)
    return true
  }
  if (sub !== 'budget') return false
  reviewBudgetCommand(argv, flags, presentation)
  return true
}

export async function dispatchReviewCommand(
  sub: string | undefined,
  argv: string[],
  flags: ReviewFlags,
  presentation: ReviewPresentation,
): Promise<void> {
  if (flags.has('dry-run') && sub !== 'restore-triage') {
    throw new Error(`--dry-run is only valid for ${PLATFORM_SLUG} review restore-triage`)
  }
  if (dispatchReadOnlyReviewCommand(sub, argv, flags, presentation)) return
  if (sub === 'project-record') {
    if (argv.length !== 3) {
      throw new Error(
        `${PLATFORM_SLUG} review project-record <branch> --cwd <tree> --reason "<one line>"`,
      )
    }
    recordProjectReviewCommand(argv[2]!, flags.flag('cwd'), flags.flag('reason'), presentation)
    return
  }
  if (sub === 'amend') {
    amendReviewFindingCommand(argv, flags, presentation)
    return
  }
  if (sub === 'restore-findings') {
    if (argv.length !== 2) {
      throw new Error(
        `${PLATFORM_SLUG} review restore-findings [--json] [--write --confirm-restore] ` +
          '[--confirm-live-store <path>]',
      )
    }
    restoreReviewFindingsCommand(flags, presentation)
    return
  }
  if (sub === 'restore-triage') {
    if (argv.length !== 2)
      throw new Error(`${PLATFORM_SLUG} review restore-triage [--dry-run] [--json]`)
    restoreReviewTriageCommand(flags, presentation)
    return
  }
  await reviewCommand(sub, argv, flags, presentation)
}
