import { declaredProjectSpace } from './declared-project-space.ts'
import {
  isProjectRepository,
  missingProjectLandingBranchProblem,
  type Project,
  projectLifecycleForm,
  validateProjectSettings,
} from './projects.ts'

/** Publish one project-register row through the shared hub contract. */
export function listedProjectJson(project: Project) {
  const { recordId, recordRevision: _recordRevision, retiredAt, ...rest } = project
  return {
    ...rest,
    visibility: project.settings.visibility ?? null,
    record_id: recordId,
    repository: isProjectRepository(project),
    ...(retiredAt ? { retired_at: retiredAt } : {}),
    lifecycle_form: projectLifecycleForm(project),
    problems: projectProblems(project),
    commit_hooks_skipped: true,
    gate: typeof project.settings.gate === 'string' ? project.settings.gate : null,
  }
}

export function projectProblems(project: Project): string[] {
  const declared = declaredProjectSpace(project)
  const missingTrunk = missingProjectLandingBranchProblem(project)
  return [
    ...validateProjectSettings(project.settings, 'strip', project.path),
    ...('refused' in declared && !project.retiredAt ? [declared.refused] : []),
    ...(missingTrunk ? [missingTrunk] : []),
  ]
}
