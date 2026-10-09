// concern: review-applicability
/** Selects the project's ordered review lenses for one classified change. */

import type { ReviewSettings } from '../project/project-injection.ts'

const BUILT_IN_REVIEW: ReviewSettings = {
  lenses: [{ lens: 'correctness' }, { lens: 'craft', minTier: 2 }, { lens: 'safety', minTier: 3 }],
}

/** Decide the distinct catalogue lenses that apply, preserving declaration order. */
export function applicableReviewLenses(
  tier: 0 | 1 | 2 | 3,
  changedPaths: readonly string[],
  review: ReviewSettings | undefined,
): string[] {
  if (tier === 0) return []
  const selected: string[] = []
  for (const entry of (review ?? BUILT_IN_REVIEW).lenses) {
    if (tier < (entry.minTier ?? 1)) continue
    if (
      entry.paths &&
      !entry.paths.some((pattern) => changedPaths.some((path) => new Bun.Glob(pattern).match(path)))
    ) {
      continue
    }
    if (!selected.includes(entry.lens)) selected.push(entry.lens)
  }
  return selected
}
