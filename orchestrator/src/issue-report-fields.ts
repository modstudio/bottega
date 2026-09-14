// concern: issue-report-fields
/**
 * Decide which fields a parsed issue report still requires for its kind.
 * Knows only issue kinds and their conditional fields; must not know MCP, Zod, or filing.
 */

export const CONDITIONAL_ISSUE_REPORT_FIELD_REASONS = {
  reproduce_command: 'provide the exact command that reproduces or demonstrates the issue',
  environment: 'state the environment details that matter to reproducing the issue',
} as const

export type ConditionalIssueReportField = keyof typeof CONDITIONAL_ISSUE_REPORT_FIELD_REASONS

export type ParsedIssueReportFields = {
  kind: 'defect' | 'suggestion'
  reproduce_command?: string
  environment?: string
}

const DEFECT_FIELDS = Object.keys(CONDITIONAL_ISSUE_REPORT_FIELD_REASONS) as ConditionalIssueReportField[]

export function missingIssueReportFields(input: ParsedIssueReportFields): ConditionalIssueReportField[] {
  if (input.kind === 'suggestion') return []
  return DEFECT_FIELDS.filter((field) => input[field] === undefined)
}
