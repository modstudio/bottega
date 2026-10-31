// concern: board-text-secret
/** Strict secret-shaped refusal for operator-authored board text. */

import { secretShapedRule } from '../../../shared/secret-shaped.ts'

export function boardTextSecretRefusal(leadingWords: string, text: string): string | null {
  const rule = secretShapedRule(text)
  if (rule === null) return null
  const remedy =
    rule === 'hex-run'
      ? 'a 32+ hex run looks like a credential; if it is a commit hash, abbreviate it to 12 characters'
      : 'remove the credential and retry'
  return `${leadingWords} contains secret-shaped text (${rule}); ${remedy}`
}

export function boardTextsSecretRefusal(
  leadingWords: string,
  texts: Array<string | undefined>,
): string | null {
  for (const text of texts) {
    if (text === undefined) continue
    const refusal = boardTextSecretRefusal(leadingWords, text)
    if (refusal) return refusal
  }
  return null
}
