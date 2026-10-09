// concern: filed-issue queue policy
/** Selects and bounds filed issues without knowing their storage or dispatch adapters. */

import { parseFiledIssue } from './issue-file.ts'

export const MAX_ISSUES_PER_PASS = 5
export const MAX_HELD_ISSUE_TREES = 3

export type FiledIssueTaskRow = {
  key: string
  title: string | null
  body: string | null
  status_category: string | null
  opened_at: string | null
}

export function eligibleFiledIssueTasks(
  rows: FiledIssueTaskRow[],
  claimIsLive: (key: string) => boolean,
): FiledIssueTaskRow[] {
  return rows
    .filter((task) => {
      try {
        if (parseFiledIssue({ task }).kind !== 'defect') return false
      } catch {
        return false
      }
      return (
        task.status_category === 'open' ||
        (task.status_category === 'active' && !claimIsLive(task.key))
      )
    })
    .sort(
      (left, right) =>
        (left.opened_at ?? '').localeCompare(right.opened_at ?? '') ||
        left.key.localeCompare(right.key),
    )
}

export type QueueStop = 'issue-limit' | 'held-tree-limit' | null

export function filedIssueQueueStop(issuesTaken: number, heldTreeCount: number): QueueStop {
  if (heldTreeCount >= MAX_HELD_ISSUE_TREES) return 'held-tree-limit'
  if (issuesTaken >= MAX_ISSUES_PER_PASS) return 'issue-limit'
  return null
}

const LOOP_STAGE_JOB = {
  diagnosis: 'diagnose',
  fix: 'issue-worker',
  'blast radius': 'review-lens',
  review: 'review-lens',
} as const

export type FiledIssueLoopRun = { runId: number; job: string; issueKey: string }

/** Identify a workIssue-started run from the label and job it records. */
export function filedIssueLoopRun(row: {
  id: number
  job: string
  label: string | null
}): FiledIssueLoopRun | null {
  const match = row.label?.match(
    /^issue ([A-Z][A-Z0-9]*-[0-9]+) (diagnosis|fix|blast radius|review [a-z0-9-]+)$/,
  )
  if (!match) return null
  const issueKey = match[1]!
  const stage = (
    match[2]!.startsWith('review ') ? 'review' : match[2]
  ) as keyof typeof LOOP_STAGE_JOB
  if (row.job !== LOOP_STAGE_JOB[stage]) return null
  return { runId: row.id, job: row.job, issueKey }
}
