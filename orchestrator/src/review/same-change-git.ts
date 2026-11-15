// concern: review-same-change-git
/** Gathers Git facts for the pure same-change decision. */

import { changeIdentity, zeroContextChangeIdentity } from './change-identity.ts'
import type { CoverageGitRunner } from './review-types.ts'
import { type SameChangeDecision, sameChange } from './same-change.ts'

type StoredChange = {
  patchId: string | null
  zeroContextPatchId: string | null
  paths: readonly string[]
  message: string | null
}

const reachable = (runner: CoverageGitRunner, commit: string) =>
  runner(['cat-file', '-e', `${commit}^{commit}`]).ok

const measured = (
  runner: CoverageGitRunner,
  from: string,
  to: string,
  paths: readonly string[],
  message: string | null,
): StoredChange => ({
  patchId: changeIdentity(runner, from, to),
  zeroContextPatchId: zeroContextChangeIdentity(runner, from, to),
  paths,
  message,
})

/** Compare a stored reviewed range with the current range, including trivial replay. */
export function gatherSameChange(input: {
  runner: CoverageGitRunner
  reviewed: StoredChange
  reviewedCommit: string
  oldBase: string
  current: { paths: readonly string[]; message: string | null }
  tip: string
  tipTree: string
  newBase: string
}): SameChangeDecision {
  const currentLegacy: StoredChange = {
    patchId: changeIdentity(input.runner, input.newBase, input.tip),
    zeroContextPatchId: null,
    paths: input.current.paths,
    message: input.current.message,
  }
  const legacyDecision = sameChange({
    reviewed: input.reviewed,
    current: currentLegacy,
    replay: null,
  })
  if (input.reviewed.zeroContextPatchId === null && legacyDecision.same) return legacyDecision
  const reviewedReachable = reachable(input.runner, input.reviewedCommit)
  const oldBaseReachable = reachable(input.runner, input.oldBase)
  const reviewed =
    input.reviewed.zeroContextPatchId === null && reviewedReachable && oldBaseReachable
      ? measured(
          input.runner,
          input.oldBase,
          input.reviewedCommit,
          input.reviewed.paths,
          input.reviewed.message,
        )
      : input.reviewed
  const current = measured(
    input.runner,
    input.newBase,
    input.tip,
    input.current.paths,
    input.current.message,
  )
  const identityDecision = sameChange({ reviewed, current, replay: null })
  if (identityDecision.same) return identityDecision
  if (!reviewedReachable) {
    return sameChange({
      reviewed,
      current,
      replay: { kind: 'unavailable', reason: `reviewed commit ${input.reviewedCommit} is missing` },
    })
  }
  if (
    !oldBaseReachable ||
    !reachable(input.runner, input.newBase) ||
    !reachable(input.runner, input.tip)
  ) {
    return sameChange({
      reviewed,
      current,
      replay: { kind: 'unavailable', reason: 'change replay commit is missing' },
    })
  }
  const replay = input.runner([
    'merge-tree',
    '--write-tree',
    `--merge-base=${input.oldBase}`,
    input.newBase,
    input.reviewedCommit,
  ])
  return sameChange({
    reviewed,
    current,
    replay: replay.ok
      ? replay.out.split('\n')[0] === input.tipTree
        ? { kind: 'same-tree' }
        : { kind: 'different-tree' }
      : { kind: 'conflict' },
  })
}
