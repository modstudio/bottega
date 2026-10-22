// concern: review-applicability
/** Selects the project's ordered review lenses for one classified change. */

import type { ReviewSettings } from '../project/project-injection.ts'

const BUILT_IN_REVIEW: ReviewSettings = {
  lenses: [{ lens: 'correctness' }, { lens: 'craft', minTier: 2 }, { lens: 'safety', minTier: 3 }],
}

export type ApplicableReview = {
  lenses: string[]
  secondOpinion?: string
  lensBases?: Record<string, string>
  secondOpinionBasis?: string
}

function selectedLensRules(
  declaration: ReviewSettings,
  tier: 1 | 2 | 3,
  changedPaths: readonly string[],
): { lenses: string[]; bases: Record<string, string> } {
  const lenses: string[] = []
  const bases: Record<string, string> = {}
  for (const entry of declaration.lenses) {
    if (tier < (entry.minTier ?? 1)) continue
    if (
      entry.paths &&
      !entry.paths.some((pattern) => changedPaths.some((path) => new Bun.Glob(pattern).match(path)))
    )
      continue
    if (lenses.includes(entry.lens)) continue
    lenses.push(entry.lens)
    if (entry.basis) bases[entry.lens] = entry.basis
  }
  return { lenses, bases }
}

/** Decide the review opinions that apply, preserving lens declaration order. */
export function applicableReview(
  tier: 0 | 1 | 2 | 3,
  changedPaths: readonly string[],
  review: ReviewSettings | undefined,
): ApplicableReview {
  if (tier === 0) return { lenses: [] }
  const declaration = review ?? BUILT_IN_REVIEW
  const { lenses: selected, bases: lensBases } = selectedLensRules(declaration, tier, changedPaths)
  const secondOpinion = declaration.secondOpinion
  if (!secondOpinion || tier < (secondOpinion.minTier ?? 3)) {
    return { lenses: selected, ...(Object.keys(lensBases).length ? { lensBases } : {}) }
  }
  if (!selected.includes(secondOpinion.lens)) selected.push(secondOpinion.lens)
  return {
    lenses: selected,
    secondOpinion: secondOpinion.lens,
    ...(Object.keys(lensBases).length ? { lensBases } : {}),
    ...(secondOpinion.basis ? { secondOpinionBasis: secondOpinion.basis } : {}),
  }
}

/** Decide only the review dimensions selected by the paths touched in a fix. */
export function applicablePostFixReview(
  tier: 0 | 1 | 2 | 3,
  changedPaths: readonly string[],
  review: ReviewSettings | undefined,
): ApplicableReview {
  if (tier === 0) return { lenses: [] }
  const declaration = review ?? BUILT_IN_REVIEW
  const { lenses, bases: lensBases } = selectedLensRules(declaration, tier, changedPaths)
  const secondOpinion = declaration.secondOpinion
  if (
    !secondOpinion ||
    tier < (secondOpinion.minTier ?? 3) ||
    !lenses.includes(secondOpinion.lens)
  ) {
    return { lenses, ...(Object.keys(lensBases).length ? { lensBases } : {}) }
  }
  return {
    lenses,
    secondOpinion: secondOpinion.lens,
    ...(Object.keys(lensBases).length ? { lensBases } : {}),
    ...(secondOpinion.basis ? { secondOpinionBasis: secondOpinion.basis } : {}),
  }
}
