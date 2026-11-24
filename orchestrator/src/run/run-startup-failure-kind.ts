// concern: startup failure kind decision
/** Classifies typed startup refusals without inspecting their message text. */
import type { FailureKind } from '../failure/failure.ts'
import { RecipePrerequisiteError } from '../recipe/recipe-executable-preflight.ts'

export function startupFailureKind(error: unknown): FailureKind {
  return error instanceof RecipePrerequisiteError ? 'prerequisite' : 'harness'
}
