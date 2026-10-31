// concern: board-text-secret
/** Client-side commit abbreviation and strict server-side board text refusal. */

import { secretShapedRule } from '../../../shared/secret-shaped.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'

export type IsKnownCommit = (hex: string) => boolean
export type BoardTextCallSite =
  | 'reply'
  | 'notice'
  | 'tag'
  | 'suggestion'
  | 'claim-note'
  | 'claim-resource'
  | 'filing-failure'

const FULL_COMMIT_TOKEN = /\b(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})\b/g

/** Abbreviate only full tokens established as the exact resolved commit. */
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

/** Prepare operator-authored text in the selected caller or registered checkout. */
export function prepareBoardText(
  callSite: BoardTextCallSite,
  text: string,
  checkout: string | null | undefined,
  isKnownCommit = knownCommitInCheckout(checkout),
): string {
  void callSite
  return checkout ? abbreviateKnownCommitTokens(text, isKnownCommit) : text
}

export function boardTextSecretRefusal(leadingWords: string, text: string): string | null {
  const rule = secretShapedRule(text)
  if (rule === null) return null
  const remedy =
    rule === 'hex-run'
      ? 'a 32+ hex run looks like a credential; if it is a commit hash, abbreviate it to 12 characters'
      : 'remove the credential and retry'
  return `${leadingWords} contains secret-shaped text (${rule}); ${remedy}`
}
