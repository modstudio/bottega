// concern: review-commands
/** Routes exceptional review maintenance verbs, otherwise preserving the frozen review command. */
import { reviewCommand } from './review-commands.ts'
import { amendReviewFindingCommand } from './review-finding-amend-command.ts'
import { restoreReviewFindingsCommand } from './review-finding-restore.ts'

type ReviewFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}
type ReviewPresentation = { log(...values: unknown[]): void; usage(): never }

export async function dispatchReviewCommand(
  sub: string | undefined,
  argv: string[],
  flags: ReviewFlags,
  presentation: ReviewPresentation,
): Promise<void> {
  if (sub === 'amend') {
    amendReviewFindingCommand(argv, flags, presentation)
    return
  }
  if (sub === 'restore-findings') {
    if (argv.length !== 2) {
      throw new Error(
        'orch review restore-findings [--json] [--write --confirm-restore] ' +
          '[--confirm-live-store <path>]',
      )
    }
    restoreReviewFindingsCommand(flags, presentation)
    return
  }
  await reviewCommand(sub, argv, flags, presentation)
}
