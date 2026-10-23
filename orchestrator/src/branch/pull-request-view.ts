// concern: branches
/** Complete result returned by the pull-request view port. */
export type PullRequestView = {
  state: string
  mergedAt: string | null
  mergeCommit?: string | null
  headRefName: string
  baseRefName: string
  url: string
}
