import type { FocusedTestRunnerSettings } from './project-settings.ts'

export function focusedTestsProblems(value: FocusedTestRunnerSettings | undefined): string[] {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['focusedTests must be an object']
  }
  const problems: string[] = []
  if (typeof value.command !== 'string' || !value.command.trim()) {
    problems.push('focusedTests.command must be a non-empty string')
  }
  if (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== 'string')) {
    problems.push('focusedTests.args must be an array of strings')
  }
  return problems
}
