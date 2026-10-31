// concern: pull-request post-merge evidence
/** Records evidence that remains valid once the forge has accepted a merge. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { PullRequestChange } from './pr-admission.ts'
import { pullRequestCiIncompleteMessage, pullRequestCiRetryCommand } from './pr-ci-record.ts'

export type PullRequestMergeFacts = {
  nodeId: string
  number: number
  headCommit: string
  headBranch: string
  baseBranch: string
  title: string
  state: string
  mergeCommit: string | null
}

type PostMergeEvidenceAdapter = {
  recordLandings?(
    change: PullRequestChange,
    pullRequest: PullRequestMergeFacts,
    database: Database,
  ): void
  recordCi?(
    change: PullRequestChange,
    pullRequest: PullRequestMergeFacts,
    database: Database,
  ): string | undefined
}

export function recordPostMergeEvidence(input: {
  adapter: PostMergeEvidenceAdapter
  change: PullRequestChange
  pullRequest: PullRequestMergeFacts
  database: Database
  projectName: string
}): string | undefined {
  let recordingError: string | undefined
  try {
    input.adapter.recordLandings?.(input.change, input.pullRequest, input.database)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    recordingError = `landing recording failed for ${input.change.branch}: ${detail}`
  }
  try {
    const incomplete = input.adapter.recordCi?.(input.change, input.pullRequest, input.database)
    if (incomplete) {
      console.error(incomplete)
      recordingError ??= incomplete
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const incomplete = pullRequestCiIncompleteMessage(
      input.pullRequest.number,
      detail,
      pullRequestCiRetryCommand(input.pullRequest.number, input.projectName),
    )
    console.error(incomplete)
    recordingError ??= incomplete
  }
  return recordingError
}

/** Record durable evidence before reporting a merge whose commit lookup failed. */
export function refuseMergedWithoutCommit(
  input: Parameters<typeof recordPostMergeEvidence>[0] & { cause: unknown; target: string },
): never {
  recordPostMergeEvidence(input)
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause)
  throw new Error(
    `pull request #${input.pullRequest.number} merged, but the merge commit could not be read: ${detail}; retry with: ${PLATFORM_SLUG} pr merge ${input.target}`,
  )
}
