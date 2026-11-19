// concern: review-funnel-rebase-carry-report
/** Recomputes recorded rebase re-owes under the exact-hunks carry rule. */

import type { Database } from 'bun:sqlite'
import { projectByName } from '../project/projects.ts'
import { compareReplayedReview } from '../review/review-post-fix.ts'
import {
  reviewRemoteTrunkRefExists,
  reviewTrunkRef,
  spawnGitProbe,
} from '../review/review-target.ts'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'

export type RebaseCarryReportRow = {
  recordId: string
  facts: ReviewFunnelFacts
  verdict: ReviewFunnelVerdict
}

export type RebaseCarryReportEntry = {
  recordId: string
  project: string
  taskKey: string | null
  head: string
  before: string[]
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
  recompute: (row: RebaseCarryReportRow) => Readonly<Record<string, readonly string[]>>,
): RebaseCarryReport {
  const entries = rows.flatMap<RebaseCarryReportEntry>((row) => {
    const before = rebaseChangedLenses(row.verdict)
    if (!before.length) return []
    const base = {
      recordId: row.recordId,
      project: row.facts.change.project,
      taskKey: row.facts.change.taskKey,
      head: row.facts.change.head,
      before,
    }
    try {
      const reOwed = recompute(row)
      const after = before.filter((lens) => Object.hasOwn(reOwed, lens))
      return [
        {
          ...base,
          after,
          carried: before.filter((lens) => !after.includes(lens)),
          unavailable: null,
        },
      ]
    } catch (cause) {
      return [{ ...base, after: null, carried: null, unavailable: String(cause) }]
    }
  })
  return {
    rows: entries.length,
    before: entries.reduce((sum, row) => sum + row.before.length, 0),
    after: entries.reduce((sum, row) => sum + (row.after?.length ?? 0), 0),
    carried: entries.reduce((sum, row) => sum + (row.carried?.length ?? 0), 0),
    unavailable: entries.filter(({ unavailable }) => unavailable !== null).length,
    entries,
  }
}

function recordedRebaseRows(database: Database): RebaseCarryReportRow[] {
  return database
    .query<{ record_id: string; facts: string; verdict: string }, []>(
      'SELECT record_id,facts,verdict FROM review_funnel_decision ORDER BY recorded_at,record_id',
    )
    .all()
    .map((row) => ({
      recordId: row.record_id,
      facts: JSON.parse(row.facts) as ReviewFunnelFacts,
      verdict: JSON.parse(row.verdict) as ReviewFunnelVerdict,
    }))
}

/** Read the local decision log and compare each old re-owe with current exact-hunks policy. */
export function reviewFunnelRebaseCarryReport(database: Database): RebaseCarryReport {
  return summarizeRebaseCarryRows(recordedRebaseRows(database), (row) => {
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
    return compareReplayedReview(
      project.path,
      postFix.reviewedTip,
      row.facts.change.head,
      trunkRef,
      postFix.completed.pathsByLens,
    ).reOwedPathsByLens
  })
}
