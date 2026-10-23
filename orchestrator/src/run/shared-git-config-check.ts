// concern: recorded-run shared git config check contract

export type RecordedRunSharedGitConfigInput = {
  runId: string
  job: string
  worktree: string | null
}

export function sharedGitConfigCheckSkipReason(input: {
  vendorPid: number | null
  vendorAlive: boolean
  worktree: string | null
  sharerCount: number
}): string | null {
  if (input.vendorAlive) {
    return `shared git config check skipped: vendor pid ${input.vendorPid} is still alive`
  }
  if (input.sharerCount > 0) {
    return `shared git config check skipped: another live run still claims ${input.worktree}`
  }
  return null
}
