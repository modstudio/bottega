// concern: pull-request release admission
/** Gathers a pull request's release facts and refuses required rungs before landing. */

import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { entryClosureAtCommit } from '../release/release-entry-closure.ts'
import {
  decidePullRequestReleaseAdmission,
  type RequiredRungDecision,
  requiredRungDecision,
} from '../release/release-required.ts'

export type PullRequestReleaseFacts = {
  number: number
  headCommit: string
  baseBranch: string
}

export type PullRequestReleaseDecisionAdapter = {
  releaseDecision(
    project: Project,
    cwd: string,
    pullRequest: PullRequestReleaseFacts,
    depth?: string,
  ): RequiredRungDecision
}

export function pullRequestReleaseDecisionAtHead(
  project: Project,
  cwd: string,
  pullRequest: PullRequestReleaseFacts,
  depth?: string,
): RequiredRungDecision {
  const environment = targetGitEnvironment(cwd)
  git(['fetch', 'origin', pullRequest.baseBranch], cwd, environment, ' during release base fetch')
  const remoteBase = `refs/remotes/origin/${pullRequest.baseBranch}`
  const mergeBase = git(
    ['merge-base', pullRequest.headCommit, remoteBase],
    cwd,
    environment,
    ' during release merge-base lookup',
  )
  const projectAtHead = { ...project, path: cwd }
  return requiredRungDecision(
    projectAtHead,
    () =>
      splitNulPaths(
        git(
          nulPathListArgs(['diff', '--name-only', mergeBase, pullRequest.headCommit]),
          cwd,
          environment,
          ' during pull-request changed-path lookup',
        ),
      ),
    (entries) => entryClosureAtCommit(projectAtHead, pullRequest.headCommit, entries),
    depth,
  )
}

export function assertPullRequestReleaseAdmission(input: {
  project: Project
  cwd: string
  pullRequest: PullRequestReleaseFacts
  adapter: PullRequestReleaseDecisionAdapter
  releaseRequired: boolean
  depth?: string
}): void {
  const admission = decidePullRequestReleaseAdmission({
    decision: input.adapter.releaseDecision(
      input.project,
      input.cwd,
      input.pullRequest,
      input.depth,
    ),
    releaseRequired: input.releaseRequired,
  })
  if (admission.kind === 'refuse') {
    throw new Error(admission.message.replace('<n>', String(input.pullRequest.number)))
  }
}
