// concern: pull-request release admission
/** Gathers a pull request's release facts and refuses required rungs before landing. */

import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { entryClosureAtCommit } from '../release/release-entry-closure.ts'
import {
  explicitlyRequiredRungs,
  type RequiredRungDecision,
  requiredRungDecision,
  requiredRungSentence,
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
  const explicitlyRequired = explicitlyRequiredRungs(input.decision)
  if (input.releaseRequired || explicitlyRequired.length === 0) return { kind: 'allow' }
  return {
    kind: 'refuse',
    message: renderRefusal(
      refusal(`refusing merge: ${requiredRungSentence(explicitlyRequired)}`, {
        kind: 'edit',
        text: requiredMergeCommand(input.target, input.depth),
      }),
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

function assertPullRequestReleaseAdmission(input: {
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

export async function preparePullRequestRelease(input: {
  target: string
  project: Project
  cwd: string
  pullRequest: PullRequestReleaseFacts
  adapter: PullRequestReleaseDecisionAdapter
  releaseRequired: boolean
  depth?: string
  changedPaths: readonly string[]
  releasePreflight:
    | ((facts: {
        project: Project
        headCommit: string
        changedPaths: readonly string[]
        target: string
      }) => Promise<void>)
    | undefined
}): Promise<RequiredRungDecision | undefined> {
  const decision = assertPullRequestReleaseAdmission(input)
  if (input.releaseRequired)
    await input.releasePreflight?.({
      project: input.project,
      headCommit: input.pullRequest.headCommit,
      changedPaths: input.changedPaths,
      target: input.target,
    })
  return rungsCanBeExplicitlyRequired(input.project.settings.release?.rungs ?? [])
    ? decision
    : undefined
}
