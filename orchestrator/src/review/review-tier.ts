import { targetGitEnvironment } from '../git/git-environment.ts'
import type { ReviewTierFile } from './review-tier-classifier.ts'

type TierRangeEndpointKind = 'commit' | 'tree' | 'other' | 'unresolvable'

export type TierRangeEndpoint = {
  ref: string
  commit: string | null
  kind: TierRangeEndpointKind
}

export type TierRangeFacts = {
  from: TierRangeEndpoint
  to: TierRangeEndpoint
  mergeBase: string | null
}

const TIER_RANGE_FORMS = '<from>..<to> or <from>...<to>'

export function parseTierRange(
  value: string,
): { from: string; to: string } | { refusal: string } | null {
  const range = value.match(/^(.+?)(\.{2,})(.+)$/)
  if (!range) return null
  const [, from, separator, to] = range
  if ((separator !== '..' && separator !== '...') || to!.includes('..')) {
    return { refusal: `review tier range must use ${TIER_RANGE_FORMS}` }
  }
  return { from: from!, to: to! }
}

export function resolveTierRange(
  facts: TierRangeFacts,
): { from: string; to: string } | { refusal: string } {
  for (const endpoint of [facts.from, facts.to]) {
    if (endpoint.kind === 'unresolvable') {
      return {
        refusal:
          `tier range endpoint "${endpoint.ref}" could not be resolved to a commit; ` +
          'if this checkout lacks the ref, fetch it, or if it is not a valid revision expression, check the spelling',
      }
    }
    if (endpoint.kind !== 'commit') {
      return {
        refusal: `tier range endpoint "${endpoint.ref}" resolves to ${endpoint.kind === 'tree' ? 'a tree' : 'a non-commit object'}; run git rev-parse HEAD and supply a commit ref instead`,
      }
    }
  }
  if (!facts.mergeBase) {
    return {
      refusal:
        `could not establish a merge base for "${facts.from.ref}" and "${facts.to.ref}"; ` +
        'use refs from related histories, or for a shallow clone run git fetch --deepen=100 (or git fetch the missing history), then retry',
    }
  }
  return { from: facts.mergeBase, to: facts.to.commit! }
}

export function diffNumstat(repo: string, from: string, to: string): ReviewTierFile[] {
  const result = Bun.spawnSync(['git', 'diff', '--no-renames', '--numstat', `${from}..${to}`], {
    cwd: repo,
    env: targetGitEnvironment(repo),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git diff exited ${result.exitCode}`)
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split('\t')
      return {
        path: path.join('\t'),
        insertions: Number(added) || 0,
        deletions: Number(removed) || 0,
      }
    })
}
