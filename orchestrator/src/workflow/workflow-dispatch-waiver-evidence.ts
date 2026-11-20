// concern: workflow-dispatch-waiver-evidence
/** Gathers declarative dispatch-waiver facts from their canonical review decisions. */

import type { Database } from 'bun:sqlite'
import {
  continuationLineageHasAcceptedFindings,
  continuationLineageHasMeasuredRound,
  continuationRoundHasAcceptedFindings,
} from '../review/review-continuation-findings.ts'
import { measureChangeGroup } from '../review/review-group.ts'
import {
  resolveBranchUnderReview,
  reviewOwedArgumentRemedy,
} from './workflow-review-owed-checkout.ts'
import type { DispatchWaiverFact } from './workflow-run-obligation.ts'

export type DispatchWaiverEvidence =
  | { action: 'allow'; facts: DispatchWaiverFact[] }
  | { action: 'refuse'; message: string }

const refusal = (condition: string): DispatchWaiverEvidence => ({
  action: 'refuse',
  message: `no-accepted-findings cannot be established: ${condition}; ${reviewOwedArgumentRemedy}`,
})

export function gatherNoAcceptedFindingsFact(
  projectName: string,
  args: Record<string, string>,
  database: Database,
): DispatchWaiverEvidence {
  const resolved = resolveBranchUnderReview(projectName, args, database)
  if (resolved.action === 'refuse') {
    if (resolved.kind === 'project')
      return refusal(
        `${resolved.condition}; register it with project add <path> --name ${projectName}`,
      )
    return refusal(resolved.condition)
  }
  const measured = measureChangeGroup(resolved.cwd, resolved.project, resolved.branch, resolved.tip)
  if (!measured)
    return refusal(`could not measure the current change group for branch ${resolved.branch}`)
  if (!continuationLineageHasMeasuredRound(database, measured.group)) {
    return {
      action: 'allow',
      facts: continuationLineageHasAcceptedFindings(database, measured.group)
        ? []
        : ['no-accepted-findings'],
    }
  }
  return {
    action: 'allow',
    facts: continuationRoundHasAcceptedFindings(database, measured.group)
      ? []
      : ['no-accepted-findings'],
  }
}
