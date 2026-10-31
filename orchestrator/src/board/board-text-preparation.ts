// concern: board-text-preparation
/** Caller-side commit abbreviation for operator-authored board text. */

import { resolveCommitArgument } from '../git/commit-resolution.ts'

export type IsKnownCommit = (hex: string) => boolean

const FULL_COMMIT_TOKEN = /\b(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})\b/g

export function abbreviateKnownCommitTokens(text: string, isKnownCommit: IsKnownCommit): string {
  return text.replace(FULL_COMMIT_TOKEN, (token) =>
    isKnownCommit(token) ? token.slice(0, 12) : token,
  )
}

function knownCommitInCheckout(checkout: string | null | undefined): IsKnownCommit {
  if (!checkout) return () => false
  return (hex) => {
    try {
      return resolveCommitArgument(checkout, hex) === hex
    } catch {
      return false
    }
  }
}

export function boardTextCheckout(input: {
  callerCwd: string
  callerProject: string | null
  targetProject: string | null
  targetProjectPath: string | null
}): string | null {
  if (input.callerProject && input.callerProject === input.targetProject) return input.callerCwd
  return input.targetProjectPath
}

export function prepareBoardText(
  text: string,
  checkout: string | null | undefined,
  isKnownCommit = knownCommitInCheckout(checkout),
): string {
  return checkout ? abbreviateKnownCommitTokens(text, isKnownCommit) : text
}

type BoardNoticeText = {
  title: string
  body: string
  task?: string
  paths?: string[]
  topics?: string[]
}

export function prepareBoardNoticeText<T extends BoardNoticeText>(
  input: T,
  checkout: string | null | undefined,
  isKnownCommit?: IsKnownCommit,
): T {
  const prepare = (text: string) => prepareBoardText(text, checkout, isKnownCommit)
  return {
    ...input,
    title: prepare(input.title),
    body: prepare(input.body),
    task: input.task === undefined ? undefined : prepare(input.task),
    paths: input.paths?.map(prepare),
    topics: input.topics?.map(prepare),
  }
}
