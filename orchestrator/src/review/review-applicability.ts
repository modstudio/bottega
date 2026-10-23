// concern: review-applicability
/** Selects the project's ordered review lenses for one classified change. */

import type { ReviewSettings } from '../project/project-injection.ts'
import { declaredGlobsMatch } from './review-declared-globs.ts'
import {
  classifyReviewTier,
  type ReviewTier,
  type ReviewTierFile,
} from './review-tier-classifier.ts'
import type { ReviewLensSelectionReason } from './review-vocabulary.ts'

const BUILT_IN_REVIEW: ReviewSettings = {
  lenses: [{ lens: 'correctness' }, { lens: 'craft', minTier: 2 }, { lens: 'safety', minTier: 3 }],
}

/** Lenses that remain relevant regardless of their declared path scope. */
export function isAlwaysRelevantLens(lens: string): boolean {
  return lens === 'correctness'
}

export type ApplicableReview = {
  lenses: string[]
  secondOpinion?: string
  lensBases?: Record<string, string>
  secondOpinionBasis?: string
  lensReasons?: Record<string, ReviewLensSelectionReason>
}

export type ReviewPlan = {
  tier: ReviewTier
  applicability: ApplicableReview
}

/** Keep only selected lenses and their attached applicability metadata. */
export function selectReviewApplicability(
  applicable: ApplicableReview,
  lenses: string[],
): ApplicableReview {
  const selected = new Set(lenses)
  const lensBases = Object.fromEntries(
    Object.entries(applicable.lensBases ?? {}).filter(([lens]) => selected.has(lens)),
  )
  const lensReasons = Object.fromEntries(
    Object.entries(applicable.lensReasons ?? {}).filter(([lens]) => selected.has(lens)),
  )
  return {
    lenses,
    ...(applicable.secondOpinion && selected.has(applicable.secondOpinion)
      ? { secondOpinion: applicable.secondOpinion }
      : {}),
    ...(Object.keys(lensBases).length ? { lensBases } : {}),
    ...(applicable.secondOpinion &&
    selected.has(applicable.secondOpinion) &&
    applicable.secondOpinionBasis
      ? { secondOpinionBasis: applicable.secondOpinionBasis }
      : {}),
    ...(Object.keys(lensReasons).length ? { lensReasons } : {}),
  }
}

/** Classify one change and select its review lenses from those same file facts. */
export function applicableReviewForChange(
  files: ReviewTierFile[],
  review: ReviewSettings | undefined,
): ReviewPlan {
  const tier = classifyReviewTier({ files, risk: review?.risk })
  return {
    tier,
    applicability: applicableReview(
      tier.tier,
      files.map(({ path }) => path),
      review,
    ),
  }
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
    if (declaration.unscopedLenses === 'skip' && !isAlwaysRelevantLens(entry.lens) && !entry.paths)
      continue
    if (entry.paths && !declaredGlobsMatch(changedPaths, entry.paths)) continue
    if (lenses.includes(entry.lens)) continue
    lenses.push(entry.lens)
    if (entry.basis) bases[entry.lens] = entry.basis
  }
  return { lenses, bases }
}

/** Lenses whose declaration can select them from newly touched paths. */
export function pathScopedLenses(review: ReviewSettings | undefined): string[] {
  return (review ?? BUILT_IN_REVIEW).lenses
    .filter(({ paths }) => paths !== undefined)
    .map(({ lens }) => lens)
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
  if (
    declaration.unscopedLenses === 'skip' &&
    !isAlwaysRelevantLens(secondOpinion.lens) &&
    !declaration.lenses.some(
      (entry) =>
        entry.lens === secondOpinion.lens &&
        entry.paths !== undefined &&
        declaredGlobsMatch(changedPaths, entry.paths),
    )
  ) {
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
