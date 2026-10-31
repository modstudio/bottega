// concern: board-text-secret
/** Secret-shaped board text, with exact known commit hashes removed before detection. */

import { secretShapedRule } from '../../../shared/secret-shaped.ts'
import { resolveCommitArgument } from '../git/commit-resolution.ts'

export type IsKnownCommit = (hex: string) => boolean

const FULL_COMMIT_TOKEN = /\b(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})\b/g

/** Return the first secret-shaped rule after removing only full hashes known as commits. */
export function boardTextSecretRule(text: string, isKnownCommit: IsKnownCommit): string | null {
  const filtered = text.replace(FULL_COMMIT_TOKEN, (token) => (isKnownCommit(token) ? '_' : token))
  return secretShapedRule(filtered)
}

/** Gather commit-resolution facts from a registered checkout for the pure predicate. */
export function knownCommitInCheckout(checkout: string | null | undefined): IsKnownCommit {
  if (!checkout) return () => false
  return (hex) => {
    try {
      return resolveCommitArgument(checkout, hex) === hex
    } catch {
      return false
    }
  }
}

export function boardTextSecretRefusal(
  leadingWords: string,
  text: string,
  checkout?: string | null,
): string | null {
  const rule = boardTextSecretRule(text, knownCommitInCheckout(checkout))
  if (rule === null) return null
  const remedy =
    rule === 'hex-run'
      ? `abbreviate the hash to 12 characters, or fetch the commit into ${checkout ?? '<registered project checkout>'}`
      : 'remove the credential and retry'
  return `${leadingWords} contains secret-shaped text (${rule}); ${remedy}`
}
