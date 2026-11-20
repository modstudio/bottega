// concern: workflow-dispatch-waiver-evidence
/** Gathers declarative dispatch-waiver facts from their canonical review decisions. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { projectByName } from '../project/projects.ts'
import { continuationRoundHasAcceptedFindings } from '../review/review-continuation-findings.ts'
import { measureChangeGroup } from '../review/review-group.ts'
import { gitText } from './workflow-floor-evidence-checkout.ts'
import {
  decideReviewOwedCheckout,
  reviewOwedArgumentRemedy,
} from './workflow-review-owed-checkout.ts'
import type { DispatchWaiverFact } from './workflow-run-obligation.ts'

export type DispatchWaiverEvidence =
  | { action: 'allow'; facts: DispatchWaiverFact[] }
  | { action: 'refuse'; message: string }

const refusal = (condition: string): DispatchWaiverEvidence => ({
  action: 'refuse',
  message: `dispatch waiver no-accepted-findings cannot be established: ${condition}; ${reviewOwedArgumentRemedy}`,
})

export function gatherNoAcceptedFindingsFact(
  projectName: string,
  args: Record<string, string>,
  database: Database,
): DispatchWaiverEvidence {
  const project = projectByName(projectName, database)
  if (!project)
    return refusal(
      `project ${projectName} is not registered; register it with ${PLATFORM_SLUG} project add <path> --name ${projectName}`,
    )
  const worktreeArg = args.worktree?.trim() || null
  const worktreeExists = Boolean(worktreeArg && existsSync(worktreeArg))
  const checkout = decideReviewOwedCheckout({
    worktreeArg,
    worktreeExists,
    worktreeHead:
      worktreeArg && worktreeExists
        ? gitText(worktreeArg, ['rev-parse', '--abbrev-ref', 'HEAD'])
        : null,
    branchArg: args.branch?.trim() || null,
    projectPath: project.path,
  })
  if ('refusal' in checkout) return refusal(checkout.refusal)
  const tip =
    gitText(checkout.cwd, ['rev-parse', '--verify', `${checkout.branch}^{commit}`]) ??
    gitText(checkout.cwd, ['rev-parse', '--verify', `origin/${checkout.branch}^{commit}`])
  if (!tip) return refusal(`cannot resolve the current tip of branch ${checkout.branch}`)
  const measured = measureChangeGroup(checkout.cwd, project, checkout.branch, tip)
  if (!measured)
    return refusal(`could not measure the current change group for branch ${checkout.branch}`)
  return {
    action: 'allow',
    facts: continuationRoundHasAcceptedFindings(database, measured.group)
      ? []
      : ['no-accepted-findings'],
  }
}
