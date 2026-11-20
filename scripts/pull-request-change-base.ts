#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

export type PullRequestChangeEvent = {
  merge_group?: { base_sha?: string }
}

export type PullRequestChangeBaseDecision =
  | { revision: string; refusal?: never }
  | { revision?: never; refusal: string }

/** Select the base that excludes changes the target branch contributed to a CI merge ref. */
export function pullRequestChangeBase(
  event: PullRequestChangeEvent,
  eventName: string,
): PullRequestChangeBaseDecision {
  if (eventName === 'pull_request') return { revision: 'HEAD^1' }
  if (eventName !== 'merge_group') {
    return {
      refusal: `GitHub event ${eventName || '<missing>'} is not a pull_request or merge_group event`,
    }
  }
  const baseSha = event.merge_group?.base_sha
  if (!baseSha) {
    return { refusal: 'GitHub merge_group event is missing merge_group.base_sha' }
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
    const decision = pullRequestChangeBase(event, eventName)
    if (decision.refusal) throw new Error(decision.refusal)
    console.log(decision.revision)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
