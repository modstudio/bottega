// concern: workflow promotion admission adapter
/** Observes checkout containment and applies the pure promotion admission decision. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { flagValue } from '../cli/args.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { decideWorkflowPromotionAdmission } from './workflow-promotion-admission.ts'

export type PromotionContainsHead = (
  root: string,
  landingBranch: string,
) => { contains: boolean; failure?: string }

export function admittedWorkflowPromotion(input: {
  argv: string[]
  root: string
  project: Project | null
  containsHead?: PromotionContainsHead
}): { reason: string | undefined; author: string | undefined } {
  const landingBranch = input.project?.settings.trunk?.trim() || null
  let contains = false
  let failure: string | undefined
  if (landingBranch) {
    const observed = input.containsHead
      ? input.containsHead(input.root, landingBranch)
      : (() => {
          const result = startBoundedSync(
            ['git', 'merge-base', '--is-ancestor', 'HEAD', landingBranch],
            { budget: 'git-plumbing', cwd: input.root, env: targetGitEnvironment(input.root) },
          )
          return {
            contains: result.exitCode === 0,
            ...(result.exitCode > 1
              ? { failure: result.stderr.trim() || `git exited ${result.exitCode}` }
              : {}),
          }
        })()
    contains = observed.contains
    failure = observed.failure
  }
  const fromOperator = input.argv.includes('--from-operator')
  const decision = decideWorkflowPromotionAdmission({
    landingBranch,
    landingBranchContainsHead: contains,
    inspectionFailure: failure,
    fromOperator,
    reason: flagValue(input.argv, 'reason'),
    author: flagValue(input.argv, 'author'),
    operatorName: fromOperator ? 'Shmuel Barkin' : null,
  })
  if (decision.verdict === 'refuse') throw new Error(decision.message)
  return decision
}
