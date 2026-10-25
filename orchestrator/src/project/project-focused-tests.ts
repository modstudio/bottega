import { validateFocusedTestDeclaration } from '../focused-test/focused-test-decision.ts'

export function focusedTestsProblems(value: unknown): string[] {
  return validateFocusedTestDeclaration(value).problems
}
