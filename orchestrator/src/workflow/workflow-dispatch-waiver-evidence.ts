// concern: workflow-dispatch-waiver-evidence
/** Gathers declarative dispatch-waiver facts from their canonical review decisions. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { projectByName } from '../project/projects.ts'
import { continuationRoundHasAcceptedFindings } from '../review/review-continuation-findings.ts'
import { measureChangeGroup } from '../review/review-group.ts'
import type { DispatchWaiverFact } from './workflow-run-obligation.ts'
import { gitText } from './workflow-floor-evidence-checkout.ts'
import { decideReviewOwedCheckout } from './workflow-review-owed-checkout.ts'

export function gatherNoAcceptedFindingsFact(
  projectName: string,
  args: Record<string, string>,
  database: Database,
): DispatchWaiverFact[] {
  const project = projectByName(projectName, database)
  if (!project) throw new Error(`project ${projectName} is not registered`)
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
  if ('refusal' in checkout) throw new Error(checkout.refusal)
  const tip =
    gitText(checkout.cwd, ['rev-parse', '--verify', `${checkout.branch}^{commit}`]) ??
    gitText(checkout.cwd, ['rev-parse', '--verify', `origin/${checkout.branch}^{commit}`])
  if (!tip) throw new Error(`cannot resolve the current tip of branch ${checkout.branch}`)
  const measured = measureChangeGroup(checkout.cwd, project, checkout.branch, tip)
  if (!measured)
    throw new Error(`could not measure the current change group for branch ${checkout.branch}`)
  return continuationRoundHasAcceptedFindings(database, measured.group)
    ? []
    : ['no-accepted-findings']
}
