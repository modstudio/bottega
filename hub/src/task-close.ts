import { type BranchPruneResult, classifyTaskBranches, pruneTaskBranches } from './orch.ts'
import { closeTask, commentTask, showTask, type TaskRow, type TaskScope } from './task.ts'

export type TaskBranchLandingCheck =
  | {
      available: true
      unlanded: { branch: string; reason: string }[]
    }
  | { available: false; reason: string }

export type TaskCloseDecision =
  | { action: 'close'; comment: string | null }
  | { action: 'refuse'; reason: string }

/** Decide whether task closure is safe from the already-observed branch facts. */
export function decideTaskClose(
  classification: TaskBranchLandingCheck,
  forceReason?: string,
): TaskCloseDecision {
  if (!classification.available) {
    return {
      action: 'refuse',
      reason: `branch classification unavailable: ${classification.reason}; restore orch and git access, then retry`,
    }
  }
  if (classification.unlanded.length === 0) return { action: 'close', comment: null }
  if (forceReason) return { action: 'close', comment: forceReason }
  return {
    action: 'refuse',
    reason: [
      'refusing to close a task with unlanded branch work:',
      ...classification.unlanded.map(({ branch, reason }) => `  ${branch}: ${reason}`),
      'Land each branch, delete it, or pass --force "<reason>" to close and record why the work was abandoned.',
    ].join('\n'),
  }
}

function landingCheck(report: BranchPruneResult): TaskBranchLandingCheck {
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

export async function closeThenPrune(
  key: string,
  scope: TaskScope,
  keepBranches: boolean,
  forceReason: string | undefined,
  dependencies: {
    show?: typeof showTask
    classify?: typeof classifyTaskBranches
    close?: (key: string, scope: TaskScope) => Promise<TaskRow>
    comment?: typeof commentTask
    prune?: typeof pruneTaskBranches
  } = {},
) {
  const task = (dependencies.show ?? showTask)(key, scope).task
  let classification: TaskBranchLandingCheck
  try {
    classification = landingCheck(
      await (dependencies.classify ?? classifyTaskBranches)(task.project, task.key),
    )
  } catch (error) {
    classification = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const decision = decideTaskClose(classification, forceReason)
  if (decision.action === 'refuse') throw new Error(decision.reason)
  const closed = dependencies.close
    ? await dependencies.close(key, scope)
    : await closeTask(key, scope)
  if (decision.comment !== null) {
    await (dependencies.comment ?? commentTask)(
      closed.key,
      { recordId: closed.record_id },
      decision.comment,
    )
  }
  if (keepBranches) return { closed, pruned: null, pruneError: null }
  try {
    return {
      closed,
      pruned: await (dependencies.prune ?? pruneTaskBranches)(closed.project, closed.key),
      pruneError: null,
    }
  } catch (error) {
    return { closed, pruned: null, pruneError: error as Error }
  }
}
