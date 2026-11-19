// concern: review-funnel-rebase-carry-report
/** Recomputes recorded rebase re-owes under the exact-hunks carry rule. */

import type { Database } from 'bun:sqlite'
import { projectByName } from '../project/projects.ts'
import {
  compareReplayedReviewFacts,
  type RebaseCarryDecision,
  rebaseCarryDecision,
} from '../review/review-post-fix.ts'
import {
  reviewRemoteTrunkRefExists,
  reviewTrunkRef,
  spawnGitProbe,
} from '../review/review-target.ts'
import type { ReviewFunnelVerdict } from './decide-review-funnel.ts'
import type { ReviewFunnelRebaseCarryRow } from './review-funnel-store.ts'
import { reviewFunnelRebaseCarryRows } from './review-funnel-store.ts'

export type RebaseCarryReportRow = ReviewFunnelRebaseCarryRow

type RebaseCarryReportEntry = {
  recordId: string
  project: string
  taskKey: string | null
  head: string
  before: string[] | null
  after: string[] | null
  carried: string[] | null
  unavailable: string | null
}

export type RebaseCarryReport = {
  rows: number
  before: number
  after: number
  carried: number
  unavailable: number
  entries: RebaseCarryReportEntry[]
}

const rebaseChangedLenses = (verdict: ReviewFunnelVerdict): string[] =>
  verdict.lenses.filter(({ reason }) => reason === 'rebase-changed-file').map(({ lens }) => lens)

/** Reduce recorded old-rule decisions after an adapter recomputes the new rule. */
export function summarizeRebaseCarryRows(
  rows: readonly RebaseCarryReportRow[],
  recompute: (row: RebaseCarryReportRow) => {
    before: RebaseCarryDecision
    after: RebaseCarryDecision
  },
): RebaseCarryReport {
  const entries = rows.flatMap<RebaseCarryReportEntry>((row) => {
    const before = rebaseChangedLenses(row.verdict)
    if (!before.length) return []
    const base = {
      recordId: row.recordId,
      project: row.facts.change.project,
      taskKey: row.facts.change.taskKey,
      head: row.facts.change.head,
    }
    try {
      const recomputed = recompute(row)
      const recomputedBefore = before.filter((lens) =>
        Object.hasOwn(recomputed.before.reOwedPathsByLens, lens),
      )
      const after = before.filter((lens) => Object.hasOwn(recomputed.after.reOwedPathsByLens, lens))
      return [
        {
          ...base,
          before: recomputedBefore,
          after,
          carried: recomputedBefore.filter((lens) => !after.includes(lens)),
          unavailable: null,
        },
      ]
    } catch (cause) {
      return [{ ...base, before: null, after: null, carried: null, unavailable: String(cause) }]
    }
  })
  return {
    rows: entries.length,
    before: entries.reduce((sum, row) => sum + (row.before?.length ?? 0), 0),
    after: entries.reduce((sum, row) => sum + (row.after?.length ?? 0), 0),
    carried: entries.reduce((sum, row) => sum + (row.carried?.length ?? 0), 0),
    unavailable: entries.filter(({ unavailable }) => unavailable !== null).length,
    entries,
  }
}

/** Read the local decision log and compare each old re-owe with current exact-hunks policy. */
export function reviewFunnelRebaseCarryReport(database: Database): RebaseCarryReport {
  return summarizeRebaseCarryRows(reviewFunnelRebaseCarryRows(database), (row) => {
    const postFix = row.facts.postFix
    if (postFix.completed === null || !('reviewedTip' in postFix) || !postFix.reviewedTip) {
      throw new Error('recorded decision has no reviewed tip')
    }
    const project = projectByName(row.facts.change.project, database)
    if (!project) throw new Error(`project ${row.facts.change.project} is not registered`)
    const trunk = project.settings.trunk?.trim()
    if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
    const trunkRef = reviewTrunkRef(
      reviewRemoteTrunkRefExists(trunk, spawnGitProbe(project.path)),
      trunk,
    )
    const facts = compareReplayedReviewFacts(
      project.path,
      postFix.reviewedTip,
      row.facts.change.head,
      trunkRef,
      postFix.completed.pathsByLens,
    )
    return {
      before: rebaseCarryDecision({
        ...facts,
        files: facts.files.map((file) => ({ ...file, exactHunks: false })),
      }),
      after: rebaseCarryDecision(facts),
    }
  })
}
