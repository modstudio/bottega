// concern: review-commands
/** Routes exceptional review maintenance verbs, otherwise preserving the frozen review command. */
import { reviewCommand } from './review-commands.ts'
import { amendReviewFindingCommand } from './review-finding-amend-command.ts'
import { restoreReviewFindingsCommand } from './review-finding-restore.ts'
import { recordArchitectReadCommand } from './review-read.ts'
import { recordProjectReviewCommand } from './review-record-command.ts'
import { restoreReviewTriageCommand } from './review-triage-restore.ts'

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
  if (flags.has('dry-run') && sub !== 'restore-triage') {
    throw new Error('--dry-run is only valid for orch review restore-triage')
  }
  if (sub === 'read') {
    recordArchitectReadCommand(argv, flags, presentation)
    return
  }
  if (sub === 'record' && argv.length === 3 && !/^\d+$/.test(argv[2]!)) {
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
        'orch review restore-findings [--json] [--write --confirm-restore] ' +
          '[--confirm-live-store <path>]',
      )
    }
    restoreReviewFindingsCommand(flags, presentation)
    return
  }
  if (sub === 'restore-triage') {
    if (argv.length !== 2) throw new Error('orch review restore-triage [--dry-run] [--json]')
    restoreReviewTriageCommand(flags, presentation)
    return
  }
  await reviewCommand(sub, argv, flags, presentation)
}
