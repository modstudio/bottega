// concern: pull-request release admission
/** Gathers a pull request's release facts and refuses required rungs before landing. */

import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { entryClosureAtCommit } from '../release/release-entry-closure.ts'
import {
  type RequiredRungDecision,
  requiredRungDecision,
  rungsCanBeExplicitlyRequired,
} from '../release/release-required.ts'
import { requiredMergeCommand } from './pr-post-landing-payload.ts'

export type PullRequestReleaseFacts = {
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

export type PullRequestReleaseAdmission = { kind: 'allow' } | { kind: 'refuse'; message: string }

export function decidePullRequestReleaseAdmission(input: {
  decision: RequiredRungDecision
  releaseRequired: boolean
  target: string
  depth?: string
}): PullRequestReleaseAdmission {
  if (!input.decision.decided) {
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing merge: required release rungs could not be decided: ${input.decision.error}`,
          {
            kind: 'edit',
            text: requiredMergeCommand(input.target, input.depth, input.releaseRequired),
          },
        ),
      ),
    }
  }
  const explicitlyRequired = input.decision.rungs
    .filter(({ required, requiredBy }) => required && requiredBy === 'explicit')
    .map(({ rung }) => rung)
  if (input.releaseRequired || explicitlyRequired.length === 0) return { kind: 'allow' }
  return {
    kind: 'refuse',
    message: renderRefusal(
      refusal(
        `refusing merge: ${
          explicitlyRequired.length === 1 ? 'release rung' : 'release rungs'
        } ${explicitlyRequired.join(', ')} required by this pull request`,
        { kind: 'edit', text: requiredMergeCommand(input.target, input.depth) },
      ),
    ),
  }
}

export function pullRequestReleaseDecisionAtHead(
  project: Project,
  cwd: string,
  pullRequest: PullRequestReleaseFacts,
  depth?: string,
): RequiredRungDecision {
  if (!rungsCanBeExplicitlyRequired(project.settings.release?.rungs ?? []))
    return { decided: true, required: [], rungs: [], error: null }
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
  target: string
  project: Project
  cwd: string
  pullRequest: PullRequestReleaseFacts
  adapter: PullRequestReleaseDecisionAdapter
  releaseRequired: boolean
  depth?: string
}): RequiredRungDecision {
  const decision = input.adapter.releaseDecision(
    input.project,
    input.cwd,
    input.pullRequest,
    input.depth,
  )
  const admission = decidePullRequestReleaseAdmission({
    decision,
    releaseRequired: input.releaseRequired,
    target: input.target,
    depth: input.depth,
  })
  if (admission.kind === 'refuse') {
    throw new Error(admission.message)
  }
  return decision
}
