// concern: recorded-run adapter for terminal shared git config containment

import { recordRunWarning } from '../events.ts'
import { JOBS } from '../jobs/jobs.ts'
import { terminalSharedGitConfigHeader } from './shared-git-config.ts'
import type { RecordedRunSharedGitConfigInput } from './shared-git-config-check.ts'

/** Resolve the recorded job once for terminal, stop, stale, and operator paths. */
export function terminalSharedGitConfigForRecordedRun(
  input: RecordedRunSharedGitConfigInput,
): string | null {
  const recordedJob = JOBS[input.job]
  if (!recordedJob) {
    recordRunWarning(
      input.runId,
      `shared git config check could not determine whether unknown job ${input.job} writes; treating it as non-writing`,
    )
    return null
  }
  return terminalSharedGitConfigHeader({
    runId: input.runId,
    worktree: input.worktree,
    expected: Boolean(recordedJob.needs.writesRepo) && Boolean(input.worktree),
  })
}
