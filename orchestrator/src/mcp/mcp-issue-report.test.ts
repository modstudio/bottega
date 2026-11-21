import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { missingIssueReportFields } from '../issue/issue-report-fields.ts'
import type { Project } from '../project/projects.ts'
import { fileIssueTaskKey } from './mcp.ts'

const fileIssueProject = {
  settings: { worktree: { keyPattern: '^DEV-[1-9][0-9]*$' } },
} as unknown as Project

test('file_issue validates a returned key for the platform project, not the reporting project', () => {
  const reportingProject = {
    settings: { worktree: { keyPattern: '^AB-[1-9][0-9]*$' } },
  } as unknown as Project

  expect(fileIssueTaskKey('DEV-1270\n', fileIssueProject)).toBe('DEV-1270')
  expect(() => fileIssueTaskKey('DEV-1270\n', reportingProject)).toThrow(
    `${PLATFORM_SLUG} task new for file_issue did not return a valid task key; returned "DEV-1270"`,
  )
})

test('file_issue refuses a notice line followed by a task key', () => {
  expect(() => fileIssueTaskKey('hosted change sent\nDEV-1270\n', fileIssueProject)).toThrow(
    `${PLATFORM_SLUG} task new for file_issue did not return a valid task key; returned "hosted change sent\\nDEV-1270"`,
  )
})

test('kind-dependent fields have exact missing sets', () => {
  const completeSuggestion = {
    kind: 'suggestion' as const,
    what_happened: 'Expose more filing guidance',
    expected: 'Clients can construct a report without validation retries',
    evidence: 'The advertised schema contains the common report fields',
    not_established: 'Whether clients render every description',
  }
  expect(missingIssueReportFields({ kind: 'defect' })).toEqual(['reproduce_command', 'environment'])
  expect(missingIssueReportFields({ kind: 'defect', reproduce_command: 'bun run check' })).toEqual([
    'environment',
  ])
  expect(missingIssueReportFields(completeSuggestion)).toEqual([])
})
