// concern: continuation checkout identity
/** Selects a continuation's recorded checkout without consulting its caller. */

export type ContinuationCheckoutDecision =
  | { action: 'continue'; cwd: string; projectPath: string | null }
  | { action: 'refuse'; reason: 'missing-repository-identity' }
  | { action: 'refuse'; reason: 'missing-recorded-cwd' }

export function continuationCheckoutDecision(input: {
  requiresRepo: boolean
  latestCwd: string | null
  rootCwd: string | null
  rootProjectPath: string | null
}): ContinuationCheckoutDecision {
  if (!input.requiresRepo) {
    const cwd = input.latestCwd ?? input.rootCwd
    return cwd
      ? { action: 'continue', cwd, projectPath: input.rootProjectPath }
      : { action: 'refuse', reason: 'missing-recorded-cwd' }
  }
  if (!input.rootProjectPath) return { action: 'refuse', reason: 'missing-repository-identity' }
  return {
    action: 'continue',
    cwd: input.latestCwd ?? input.rootCwd ?? input.rootProjectPath,
    projectPath: input.rootProjectPath,
  }
}
