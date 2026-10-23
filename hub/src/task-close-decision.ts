import type { BranchPruneResult } from './orch.ts'

export type TaskBranchLandingCheck =
  | {
      available: true
      unlanded: { branch: string; reason: string }[]
    }
  | { available: false; reason: string }

export type TaskCloseDecision =
  | { action: 'close'; comment: string | null }
  | {
      action: 'refuse'
      reason: string
      unlanded?: { facts: string; remedy: string }
    }

/** Decide whether task closure is safe from the already-observed branch facts. */
export function decideTaskClose(
  classification: TaskBranchLandingCheck,
  abandonReason?: string,
): TaskCloseDecision {
  if (!classification.available) {
    return {
      action: 'refuse',
      reason: `branch classification unavailable: ${classification.reason}; restore orchestrator and git access, then retry`,
    }
  }
  if (classification.unlanded.length === 0) return { action: 'close', comment: null }
  if (abandonReason) return { action: 'close', comment: abandonReason }
  const facts = [
    'refusing to close a task with unlanded branch work:',
    ...classification.unlanded.map(({ branch, reason }) => `  ${branch}: ${reason}`),
  ].join('\n')
  const remedy =
    'Land each branch, delete it, or pass --abandon "<reason>" to close and record why the work was abandoned.'
  return {
    action: 'refuse',
    reason: `${facts}\n${remedy}`,
    unlanded: { facts, remedy },
  }
}

export function landingCheck(report: BranchPruneResult): TaskBranchLandingCheck {
  const unknown = report.operator.filter((row) => row.state === 'unknown')
  if (report.errors.length > 0 || unknown.length > 0) {
    const reasons = [
      ...report.errors,
      ...unknown.map((row) => `${row.branch}: branch state is unknown`),
    ]
    return { available: false, reason: reasons.join('; ') }
  }
  return {
    available: true,
    unlanded: report.operator.map((row) => ({
      branch: row.branch,
      reason: `${row.state}; ${row.commitsNotOnTrunk} commits not on trunk`,
    })),
  }
}
