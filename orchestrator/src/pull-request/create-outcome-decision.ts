// concern: pull-request create outcome
/** Decides the result of creating or rediscovering a pull request from gathered facts. */

import { type Refusal, refusal } from '../../../shared/refusal.ts'
import type { MergeabilityDecision } from './mergeability-decision.ts'

export type CreateOutcomePullRequest = {
  number: number
  url: string
  mergeability: MergeabilityDecision
}

export type PullRequestCreateResult = {
  stdout: string
  failure: string | null
}

export type CreateOutcomeDecision = {
  refusal: Refusal | null
  output: string
  finalizePullRequestNumber: number | null
}

export function decideCreateOutcome(input: {
  existing: CreateOutcomePullRequest | null
  createResult: PullRequestCreateResult | null
  created: CreateOutcomePullRequest | null
  branch: string
  platformSlug: string
}): CreateOutcomeDecision {
  if (input.existing) {
    const output = `pull request already exists for ${input.branch}: ${input.existing.url}; gh pr create was not run`
    return {
      refusal: null,
      output: pullRequestOutput(output, input.existing),
      finalizePullRequestNumber: input.existing.number,
    }
  }

  if (!input.createResult) {
    return {
      refusal: { condition: 'gh pr create was not run' },
      output: '',
      finalizePullRequestNumber: null,
    }
  }

  if (input.createResult.failure !== null) {
    return {
      refusal: refusal(`gh pr create failed: ${input.createResult.failure}`, {
        kind: 'edit',
        text: `fix the reported GitHub condition, then rerun ${input.platformSlug} pr create`,
      }),
      output: '',
      finalizePullRequestNumber: null,
    }
  }

  if (!input.created) {
    const unresolved = `gh pr view ${input.branch} could not resolve the created pull request; mergeability was not checked and the triage intent remains pending; rerun ${input.platformSlug} pr create to record it`
    return {
      refusal: null,
      output: input.createResult.stdout
        ? `${input.createResult.stdout}\n${unresolved}`
        : unresolved,
      finalizePullRequestNumber: null,
    }
  }

  return {
    refusal: null,
    output: pullRequestOutput(input.createResult.stdout, input.created),
    finalizePullRequestNumber: input.created.number,
  }
}

function pullRequestOutput(output: string, pullRequest: CreateOutcomePullRequest): string {
  const primary = output || pullRequest.url
  return pullRequest.mergeability.kind === 'report'
    ? `${primary}\n${pullRequest.mergeability.message}`
    : primary
}
