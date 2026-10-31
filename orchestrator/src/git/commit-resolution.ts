// concern: caller commit resolution
/** Resolves a caller-supplied revision to the full commit used by evidence stores. */

import { gitResult, resolveBase } from './git-environment.ts'

export type CommitResolutionFacts = {
  resolved?: string
  candidates?: readonly string[]
}

/** Decide commit resolution from git facts, without spawning git or reading a repository. */
export function decideCommitResolution(
  argument: string,
  checkout: string,
  facts: CommitResolutionFacts,
): { commit: string } | { refusal: string } {
  const commit = facts.resolved?.trim()
  if (commit) return { commit }
  const candidates = (facts.candidates ?? []).map((candidate) => candidate.trim()).filter(Boolean)
  if (candidates.length >= 2) {
    return {
      refusal: `${argument} is ambiguous in ${checkout}; candidate commits: ${candidates.join(', ')}`,
    }
  }
  return {
    refusal: `${argument} does not resolve to a commit in ${checkout}; run \`git fetch\` in that checkout, or pass the full hash`,
  }
}

/** Gather git facts in the caller's checkout and resolve its revision to a full commit. */
export function resolveCommitArgument(checkout: string, argument: string): string {
  let resolved: string | undefined
  try {
    resolved = resolveBase(checkout, argument)
  } catch {
    // The pure decision below owns the operator-facing refusal.
  }
  const candidates =
    resolved === undefined && /^[0-9a-fA-F]{4,}$/.test(argument)
      ? gitResult(['rev-parse', `--disambiguate=${argument}`], checkout)
          .stdout.split(/\r?\n/)
          .map((candidate) => candidate.trim())
          .filter(
            (candidate) =>
              candidate.length > 0 &&
              gitResult(['cat-file', '-t', candidate], checkout).stdout.trim() === 'commit',
          )
      : undefined
  const decision = decideCommitResolution(argument, checkout, { resolved, candidates })
  if ('refusal' in decision) throw new Error(decision.refusal)
  return decision.commit
}
