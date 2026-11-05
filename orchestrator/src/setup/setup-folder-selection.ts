// concern: setup-folder-selection
/** Selects repository-scoped setup material without performing I/O. */
import type { SetupPlan } from './setup-engine.ts'

const projectQuestionPath = (id: string): string | null => {
  const match = /^project:([^:]+):/.exec(id)
  return match ? decodeURIComponent(match[1]!) : null
}

export function selectSetupFolders(plan: SetupPlan, selected: readonly string[]): SetupPlan {
  const paths = new Set(selected)
  return {
    ...plan,
    proposals: plan.proposals.filter((proposal) => paths.has(proposal.repository.path)),
    questions: plan.questions.filter((question) => {
      const path = projectQuestionPath(question.id)
      return path === null || paths.has(path)
    }),
    notices: plan.notices.filter((notice) => !notice.folderPath || paths.has(notice.folderPath)),
  }
}

export function nonInteractiveSetupFolders(plan: SetupPlan, included: readonly string[]): string[] {
  const includes = new Set(included)
  return plan.proposals
    .filter((proposal) => Boolean(proposal.current) || includes.has(proposal.repository.path))
    .map((proposal) => proposal.repository.path)
}
