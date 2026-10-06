// concern: continuation checkout adapter
/** Resolves the root-recorded project and applies the pure checkout decision. */

import { type Project, projectByName } from '../project/projects.ts'
import { continuationCheckoutDecision } from './continuation-checkout.ts'

export function requireContinuationCheckout(input: {
  rootId: number
  operation: 'continued' | 'answered' | 'retried'
  requiresRepo: boolean
  latestCwd: string | null
  rootCwd: string | null
  rootRepo: string | null
}): { cwd: string; project: Project | null } {
  const project = input.rootRepo ? projectByName(input.rootRepo) : null
  const decision = continuationCheckoutDecision({
    requiresRepo: input.requiresRepo,
    latestCwd: input.latestCwd,
    rootCwd: input.rootCwd,
    rootProjectPath: project?.path ?? null,
  })
  if (decision.action === 'refuse') {
    const detail =
      decision.reason === 'missing-recorded-cwd'
        ? 'its chain has no recorded working directory'
        : 'its chain has no available registered repository identity'
    throw new Error(
      `run ${input.rootId} cannot be ${input.operation}: ${detail}; dispatch a new run`,
    )
  }
  return { cwd: decision.cwd, project }
}

export function continuationCheckoutForAnswer(input: {
  rootId: number
  skipResume: boolean
  ownersLive: boolean
  requiresRepo: boolean
  latestCwd: string | null
  rootCwd: string | null
  rootRepo: string | null
}): ReturnType<typeof requireContinuationCheckout> | null {
  if (input.skipResume || input.ownersLive) return null
  return requireContinuationCheckout({
    rootId: input.rootId,
    operation: 'answered',
    requiresRepo: input.requiresRepo,
    latestCwd: input.latestCwd,
    rootCwd: input.rootCwd,
    rootRepo: input.rootRepo,
  })
}
