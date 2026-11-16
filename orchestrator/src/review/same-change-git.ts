// concern: review-same-change-git
/** Gathers Git facts for the pure same-change decision. */

import { changeIdentity, zeroContextChangeIdentity } from './change-identity.ts'
import type { CoverageGitRunner } from './review-types.ts'
import {
  type ChangeFacts,
  type SameChangeDecision,
  sameChange,
  sameStoredChange,
} from './same-change.ts'

type StoredChange = {
  patchId: string | null
  zeroContextPatchId: string | null
  paths: readonly string[]
  message: string | null
}

export type GatheredSameChange = {
  decision: SameChangeDecision
  current: ChangeFacts & {
    patchId: string
    zeroContextPatchId: string
    paths: readonly string[]
  }
}

export type ReplayWitnessRow = {
  tip: string
  patchId: string | null
  zeroContextPatchId: string | null
  pathSet: string | null
  replayMatchesCurrent?: boolean
}

type CurrentReplayChange = {
  patchId: string
  zeroContextPatchId: string | null
  pathSet: string
  base: string
  tip: string
  tree: string
}

const parsedPaths = (pathSet: string): string[] => {
  const paths = JSON.parse(pathSet) as unknown
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
    throw new Error('stored change path_set is not a JSON array of paths')
  }
  return paths
}

/** Add a clean-replay witness only to rows whose stored identity does not match. */
export function replayWitnessesForCurrent<T extends ReplayWitnessRow>(input: {
  runner: CoverageGitRunner
  rows: readonly T[]
  current: CurrentReplayChange
  trunk: string
}): (T & { replayMatchesCurrent?: boolean })[] {
  const currentStored = {
    patchId: input.current.patchId,
    zeroContextPatchId: input.current.zeroContextPatchId,
    pathSet: input.current.pathSet,
  }
  const byTip = new Map<string, boolean>()
  return input.rows.map((row) => {
    if (sameStoredChange(row, currentStored)) return row
    let replayMatchesCurrent = byTip.get(row.tip)
    if (replayMatchesCurrent === undefined) {
      const oldBase = input.runner(['merge-base', row.tip, input.trunk])
      if (!oldBase.ok) {
        replayMatchesCurrent = false
      } else {
        try {
          replayMatchesCurrent = gatherSameChange({
            runner: input.runner,
            reviewed: {
              patchId: row.patchId,
              zeroContextPatchId: row.zeroContextPatchId ?? null,
              paths: row.pathSet === null ? [] : parsedPaths(row.pathSet),
              message: null,
            },
            reviewedCommit: row.tip,
            oldBase: oldBase.out,
            current: { paths: parsedPaths(input.current.pathSet), message: null },
            tip: input.current.tip,
            tipTree: input.current.tree,
            newBase: input.current.base,
          }).decision.same
        } catch {
          replayMatchesCurrent = false
        }
      }
      byTip.set(row.tip, replayMatchesCurrent)
    }
    return { ...row, replayMatchesCurrent }
  })
}

const reachable = (runner: CoverageGitRunner, commit: string) =>
  runner(['cat-file', '-e', `${commit}^{commit}`]).ok

const measured = (
  runner: CoverageGitRunner,
  from: string,
  to: string,
  paths: readonly string[],
  message: string | null,
): StoredChange & { patchId: string; zeroContextPatchId: string; paths: readonly string[] } => ({
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
}): GatheredSameChange {
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
  const current = measured(
    input.runner,
    input.newBase,
    input.tip,
    input.current.paths,
    input.current.message,
  )
  if (input.reviewed.zeroContextPatchId === null && legacyDecision.same) {
    return { decision: legacyDecision, current }
  }
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
  const identityDecision = sameChange({ reviewed, current, replay: null })
  if (identityDecision.same) return { decision: identityDecision, current }
  if (!reviewedReachable) {
    return {
      decision: sameChange({
        reviewed,
        current,
        replay: {
          kind: 'unavailable',
          reason: `reviewed commit ${input.reviewedCommit} is missing`,
        },
      }),
      current,
    }
  }
  if (
    !oldBaseReachable ||
    !reachable(input.runner, input.newBase) ||
    !reachable(input.runner, input.tip)
  ) {
    return {
      decision: sameChange({
        reviewed,
        current,
        replay: { kind: 'unavailable', reason: 'change replay commit is missing' },
      }),
      current,
    }
  }
  const replay = input.runner([
    'merge-tree',
    '--write-tree',
    `--merge-base=${input.oldBase}`,
    input.newBase,
    input.reviewedCommit,
  ])
  return {
    decision: sameChange({
      reviewed,
      current,
      replay: replay.ok
        ? replay.out.split('\n')[0] === input.tipTree
          ? { kind: 'same-tree' }
          : { kind: 'different-tree' }
        : { kind: 'conflict' },
    }),
    current,
  }
}
