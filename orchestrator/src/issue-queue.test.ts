import { describe, expect, test } from 'bun:test'
import {
  eligibleFiledIssueTasks,
  type FiledIssueTaskRow,
  filedIssueQueueStop,
  MAX_HELD_ISSUE_TREES,
  MAX_ISSUES_PER_PASS,
} from './issue-queue.ts'
import { filedIssueQueueFailureAction } from './issue-queue-failure.ts'

const filed = (key: string, kind: 'defect' | 'suggestion', status: string, opened: string) =>
  ({
    key,
    title: key,
    body: `FILED ISSUE DATA: ${JSON.stringify({
      version: 1,
      kind,
      reporting_project: 'project',
      submitted_title: null,
      what_happened: 'broken',
      expected: 'works',
      reproduce_command: null,
      environment: null,
      evidence: 'observed',
      not_established: 'cause',
    })}`,
    status_category: status,
    opened_at: opened,
  }) as FiledIssueTaskRow

describe('filed issue queue decisions', () => {
  test('selects defects by state and dead claim, oldest first', () => {
    const rows = [
      filed('DEV-5', 'defect', 'open', '2026-01-05'),
      filed('DEV-1', 'defect', 'open', '2026-01-01'),
      filed('DEV-2', 'suggestion', 'open', '2026-01-02'),
      filed('DEV-3', 'defect', 'review', '2026-01-03'),
      filed('DEV-4', 'defect', 'active', '2026-01-04'),
      filed('DEV-6', 'defect', 'active', '2026-01-06'),
      { ...filed('DEV-0', 'defect', 'open', '2025-01-01'), body: 'ordinary task' },
    ]
    expect(eligibleFiledIssueTasks(rows, (key) => key === 'DEV-6').map((row) => row.key)).toEqual([
      'DEV-1',
      'DEV-4',
      'DEV-5',
    ])
  })

  test('stops for held trees before the issue-count bound', () => {
    expect(filedIssueQueueStop(0, 0)).toBeNull()
    expect(filedIssueQueueStop(MAX_ISSUES_PER_PASS, 0)).toBe('issue-limit')
    expect(filedIssueQueueStop(0, MAX_HELD_ISSUE_TREES)).toBe('held-tree-limit')
    expect(filedIssueQueueStop(MAX_ISSUES_PER_PASS, MAX_HELD_ISSUE_TREES)).toBe('held-tree-limit')
  })

  test('continues after a durably recorded queue failure so the next candidate can run', () => {
    const actions = [
      filedIssueQueueFailureAction({
        queueMode: true,
        failureRecorded: true,
        movedToReview: true,
      }),
      'worked',
    ]
    expect(actions).toEqual(['continue', 'worked'])
    expect(
      filedIssueQueueFailureAction({
        queueMode: false,
        failureRecorded: true,
        movedToReview: true,
      }),
    ).toBe('throw')
    expect(
      filedIssueQueueFailureAction({
        queueMode: true,
        failureRecorded: false,
        movedToReview: true,
      }),
    ).toBe('throw')
  })
})
