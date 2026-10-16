// concern: review-applicability
/** Selects the project's ordered review lenses for one classified change. */

import type { ReviewSettings } from '../project/project-injection.ts'

const BUILT_IN_REVIEW: ReviewSettings = {
  lenses: [{ lens: 'correctness' }, { lens: 'craft', minTier: 2 }, { lens: 'safety', minTier: 3 }],
}

export type ApplicableReview = {
  lenses: string[]
  secondOpinion?: string
}

/** Decide the review opinions that apply, preserving lens declaration order. */
export function applicableReview(
  tier: 0 | 1 | 2 | 3,
  changedPaths: readonly string[],
  review: ReviewSettings | undefined,
): ApplicableReview {
  if (tier === 0) return { lenses: [] }
  const declaration = review ?? BUILT_IN_REVIEW
  const selected: string[] = []
  for (const entry of declaration.lenses) {
    if (tier < (entry.minTier ?? 1)) continue
    if (
      entry.paths &&
      !entry.paths.some((pattern) => changedPaths.some((path) => new Bun.Glob(pattern).match(path)))
    ) {
      continue
    }
    if (!selected.includes(entry.lens)) selected.push(entry.lens)
  }
  const secondOpinion = declaration.secondOpinion
  if (!secondOpinion || tier < (secondOpinion.minTier ?? 3)) {
    return { lenses: selected }
  }
  if (!selected.includes(secondOpinion.lens)) selected.push(secondOpinion.lens)
  return { lenses: selected, secondOpinion: secondOpinion.lens }
}
