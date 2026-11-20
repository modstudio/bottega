#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { budgetForArgv } from '../shared/call-budgets.ts'

export type PullRequestChangeEvent = {
  merge_group?: { base_sha?: string }
}

export type PullRequestChangeBaseDecision =
  | { revision: string; refusal?: never }
  | { revision?: never; refusal: string }

export class PullRequestChangeBaseRefusal extends Error {}

export function headHasSecondParent(): boolean {
  const argv = ['git', 'rev-parse', '--verify', '-q', 'HEAD^2']
  return startBoundedSync(argv, { budget: budgetForArgv(argv) }).exitCode === 0
}

/** Select the base that excludes changes the target branch contributed to a CI merge ref. */
export function pullRequestChangeBase(
  event: PullRequestChangeEvent,
  eventName: string,
  headHasSecondParent: boolean,
): PullRequestChangeBaseDecision {
  if (eventName === 'pull_request') {
    if (!headHasSecondParent) {
      return {
        refusal:
          'GitHub pull_request HEAD is not the pull request merge ref; check out the default merge ref by leaving actions/checkout ref: unset in this job',
      }
    }
    return { revision: 'HEAD^1' }
  }
  if (eventName !== 'merge_group') {
    return {
      refusal: `GitHub event ${eventName || '<missing>'} is not a pull_request or merge_group event; gate this step on pull_request and merge_group events`,
    }
  }
  const baseSha = event.merge_group?.base_sha
  if (!baseSha) {
    return {
      refusal:
        'GitHub merge_group event is missing merge_group.base_sha; re-run the merge-queue check',
    }
  }
  return { revision: baseSha }
}

if (import.meta.main) {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH
    const eventName = process.env.GITHUB_EVENT_NAME
    if (!eventPath || !eventName) {
      throw new Error('GITHUB_EVENT_PATH and GITHUB_EVENT_NAME are required')
    }
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestChangeEvent
    const decision = pullRequestChangeBase(
      event,
      eventName,
      eventName === 'pull_request' ? headHasSecondParent() : false,
    )
    if (decision.refusal) throw new PullRequestChangeBaseRefusal(decision.refusal)
    console.log(decision.revision)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
