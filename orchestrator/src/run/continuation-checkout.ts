// concern: continuation checkout identity
/** Selects a continuation's recorded checkout without consulting its caller. */

export type ContinuationCheckoutDecision =
  | { action: 'continue'; cwd: string; projectPath: string }
  | { action: 'refuse'; reason: 'missing-repository-identity' }

export function continuationCheckoutDecision(input: {
  latestCwd: string | null
  rootCwd: string | null
  rootProjectPath: string | null
}): ContinuationCheckoutDecision {
  if (!input.rootProjectPath) return { action: 'refuse', reason: 'missing-repository-identity' }
  return {
    action: 'continue',
    cwd: input.latestCwd ?? input.rootCwd ?? input.rootProjectPath,
    projectPath: input.rootProjectPath,
  }
}
