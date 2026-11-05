// concern: setup-folder-selection
/** Selects repository-scoped setup material without performing I/O. */
import type { SetupPlan } from './setup-engine.ts'

export function selectSetupFolders(plan: SetupPlan, selected: readonly string[]): SetupPlan {
  const paths = new Set(selected)
  return {
    ...plan,
    proposals: plan.proposals.filter((proposal) => paths.has(proposal.repository.path)),
    questions: plan.questions.filter(
      (question) => !question.folderPath || paths.has(question.folderPath),
    ),
    notices: plan.notices.filter((notice) => !notice.folderPath || paths.has(notice.folderPath)),
  }
}

export function nonInteractiveSetupFolders(plan: SetupPlan, included: readonly string[]): string[] {
  const inspected = new Set(plan.proposals.map((proposal) => proposal.repository.path))
  const unmatched = included.find((path) => !inspected.has(path))
  if (unmatched) {
    throw new Error(
      `included folder ${JSON.stringify(unmatched)} was not inspected; pass that folder, or a parent of it, with --in (for MCP, in folders)`,
    )
  }
  const includes = new Set(included)
  return plan.proposals
    .filter((proposal) => Boolean(proposal.current) || includes.has(proposal.repository.path))
    .map((proposal) => proposal.repository.path)
}
