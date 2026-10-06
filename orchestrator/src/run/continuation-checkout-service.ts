// concern: continuation checkout adapter
/** Resolves the root-recorded project and applies the pure checkout decision. */

import { type Project, projectByName } from '../project/projects.ts'
import { continuationCheckoutDecision } from './continuation-checkout.ts'

export function requireContinuationCheckout(input: {
  rootId: number
  operation: 'continued' | 'answered' | 'retried'
  latestCwd: string | null
  rootCwd: string | null
  rootRepo: string | null
}): { cwd: string; project: Project } {
  const project = input.rootRepo ? projectByName(input.rootRepo) : null
  const decision = continuationCheckoutDecision({
    latestCwd: input.latestCwd,
    rootCwd: input.rootCwd,
    rootProjectPath: project?.path ?? null,
  })
  if (decision.action === 'refuse') {
    throw new Error(
      `run ${input.rootId} cannot be ${input.operation}: its chain has no available registered repository identity; ` +
        'dispatch a new run from the registered project checkout',
    )
  }
  return { cwd: decision.cwd, project: project! }
}
