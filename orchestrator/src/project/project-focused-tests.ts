import { validateFocusedTestRunner } from '../focused-test/focused-test-decision.ts'

export function focusedTestsProblems(value: unknown): string[] {
  return validateFocusedTestRunner(value).problems
}
